import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { queryRestoreJournalEntry, runDatabaseRestore, verifyBackupManifest } from "@paperclipai/db/backup-lib";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { writeSelfTargetedRestartControlRequest } from "./restart-control.js";

// active-job.json only ever holds one of these three states. succeeded and
// failed are never written here -- they exist only as TerminalRestoreJobRecord
// content in a separate archive file (see below). confirmShutdown() only
// *requests* a self-targeted restart through the existing, unmodified
// restart-control watcher; resumeDatabaseRestoreIfNeeded() below is the only
// code that actually calls runDatabaseRestore.
export type ActiveRestoreJobState = "accepted" | "shutting_down" | "restoring";

// Deliberately holds no absolute paths, connection strings, or secrets --
// only a bare backup filename and a server-derived manifest hash.
export type RestoreJob = {
  version: 1;
  jobId: string;
  backupId: string;
  manifestSha256: string;
  state: ActiveRestoreJobState;
  requestedBy: string;
  requestedAt: string;
  updatedAt: string;
  restoreAttempts: number;
};

export type TerminalRestoreJobState = "succeeded" | "failed";

// Separate type from RestoreJob on purpose (CEO decision): succeeded/failed
// are a different kind of record, stored only in restore-jobs/archive/, never
// as active-job.json content.
export type TerminalRestoreJobRecord = {
  version: 1;
  jobId: string;
  backupId: string;
  manifestSha256: string;
  state: TerminalRestoreJobState;
  requestedBy: string;
  requestedAt: string;
  updatedAt: string;
  restoreAttempts: number;
  lastError: { code: string; message: string } | null;
};

export type AcceptRestoreJobInput = {
  backupId: string;
  backupDir: string;
  requestedBy: string;
  homeDir?: string;
};

export type AcceptRestoreJobResult =
  | { ok: true; jobId: string }
  | { ok: false; httpStatus: 400 | 404 | 409; code: string; message: string };

// Identical contract to packages/db/src/backup-lib.ts's private
// SENTINEL_BACKUP_ID_RE. That constant is not exported, so this is a
// deliberate, minimal duplication rather than a new/different rule --
// kept as a single named export here so every check in this service (and
// any test) goes through the one copy instead of re-deriving it ad hoc.
export const BACKUP_ID_RE = /^[A-Za-z0-9._-]+\.sql(\.gz)?$/;

function restoreJobsDir(homeDir?: string): string {
  return resolve(resolvePaperclipInstanceRoot({ homeDir }), "restore-jobs");
}

// Single file: both the active-job marker and its own record. Created with
// O_CREAT|O_EXCL ("wx") so two concurrent accept attempts cannot both
// succeed -- the loser gets EEXIST synchronously, with no TOCTOU window.
function activeJobPath(homeDir?: string): string {
  return resolve(restoreJobsDir(homeDir), "active-job.json");
}

export async function acceptRestoreJob(input: AcceptRestoreJobInput): Promise<AcceptRestoreJobResult> {
  const { backupId, backupDir, requestedBy, homeDir } = input;

  if (!BACKUP_ID_RE.test(backupId)) {
    return {
      ok: false,
      httpStatus: 400,
      code: "invalid_backup_id",
      message: "backupId must be a bare .sql or .sql.gz filename",
    };
  }

  const resolvedBackupDir = resolve(backupDir);
  const candidatePath = resolve(backupDir, backupId);
  if (!candidatePath.startsWith(resolvedBackupDir + sep)) {
    return {
      ok: false,
      httpStatus: 400,
      code: "invalid_backup_id",
      message: "backupId resolved outside the backup directory",
    };
  }
  if (!existsSync(candidatePath)) {
    return { ok: false, httpStatus: 404, code: "backup_not_found", message: "No such backup" };
  }

  // Re-verified here independently of the catalog's own read -- the client
  // never supplies a manifestSha256; the server always derives it fresh.
  const verification = await verifyBackupManifest(candidatePath);
  if (!verification.ok) {
    return {
      ok: false,
      httpStatus: 400,
      code: "manifest_not_valid",
      message: `Manifest is not valid: ${verification.reason}`,
    };
  }

  const jobId = randomUUID();
  const now = new Date().toISOString();
  const job: RestoreJob = {
    version: 1,
    jobId,
    backupId,
    manifestSha256: verification.manifest.sha256,
    state: "accepted",
    requestedBy,
    requestedAt: now,
    updatedAt: now,
    restoreAttempts: 0,
  };

  const dir = restoreJobsDir(homeDir);
  mkdirSync(dir, { recursive: true });
  const finalPath = activeJobPath(homeDir);

  let fd: number;
  try {
    fd = openSync(finalPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        ok: false,
        httpStatus: 409,
        code: "active_job_exists",
        message: "A restore job has already been accepted",
      };
    }
    throw error;
  }

  try {
    writeSync(fd, JSON.stringify(job, null, 2));
  } catch (error) {
    closeSync(fd);
    // Clean up only the file we just reserved ourselves -- no broader
    // recovery, no auto-expiry of anything else.
    try {
      unlinkSync(finalPath);
    } catch {
      /* best-effort; the write error below is authoritative */
    }
    throw error;
  }
  closeSync(fd);

  return { ok: true, jobId };
}

async function writeJobFileAtomic(filePath: string, job: RestoreJob): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export type RestoreControlEnv = Record<string, string | undefined>;

// Default-off: real restore execution (and therefore the self-shutdown
// request this batch can produce) only exists when this is explicitly set to
// the literal string "true". Absence of the variable is refusal, not just a
// falsy default.
export function isDatabaseRestoreExecutionEnabled(env: RestoreControlEnv = process.env): boolean {
  return env.PAPERCLIP_DB_RESTORE_EXECUTION_ENABLED === "true";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

// Mirrors scripts/operations/paperclip-control-plane-supervisor.mjs's own
// instance-root resolution exactly (PAPERCLIP_INSTANCE_ROOT, falling back to
// USERPROFILE/.paperclip/instances/default) -- deliberately NOT
// resolvePaperclipInstanceRoot(), which reads different env vars
// (PAPERCLIP_HOME/PAPERCLIP_INSTANCE_ID). The two resolutions only agree when
// no override env var diverges them; checkSupervisorCapability below treats
// any disagreement as a reason to refuse, never as a reason to guess.
function resolveSupervisorInstanceRoot(): string {
  const override = process.env.PAPERCLIP_INSTANCE_ROOT?.trim();
  if (override) return resolve(override);
  return resolve(process.env.USERPROFILE ?? "", ".paperclip", "instances", "default");
}

export type SupervisorCapabilityResult = { ok: true } | { ok: false; reason: string };

export async function checkSupervisorCapability(homeDir?: string): Promise<SupervisorCapabilityResult> {
  const serverRoot = resolve(resolvePaperclipInstanceRoot({ homeDir }));
  const supervisorRoot = resolveSupervisorInstanceRoot();
  if (serverRoot.toLowerCase() !== supervisorRoot.toLowerCase()) {
    return { ok: false, reason: "instance_root_mismatch" };
  }

  const logsDir = resolve(serverRoot, "logs");
  let runtimePidRaw: string;
  let supervisorPidRaw: string;
  try {
    runtimePidRaw = await readFile(resolve(logsDir, "control-plane-runtime.pid"), "utf8");
  } catch {
    return { ok: false, reason: "runtime_pid_unreadable" };
  }
  try {
    supervisorPidRaw = await readFile(resolve(logsDir, "control-plane-supervisor.pid"), "utf8");
  } catch {
    return { ok: false, reason: "supervisor_pid_unreadable" };
  }

  const runtimePid = Number(runtimePidRaw.trim());
  const supervisorPid = Number(supervisorPidRaw.trim());
  if (!Number.isInteger(runtimePid) || runtimePid <= 0) {
    return { ok: false, reason: "runtime_pid_invalid" };
  }
  if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) {
    return { ok: false, reason: "supervisor_pid_invalid" };
  }
  // The runtime marker must name *this exact process* -- a confirm-shutdown
  // acting on behalf of some other, unrelated runtime pid would be requesting
  // a restart for the wrong process entirely.
  if (runtimePid !== process.pid) {
    return { ok: false, reason: "runtime_pid_not_self" };
  }
  if (!isProcessAlive(supervisorPid)) {
    return { ok: false, reason: "supervisor_not_alive" };
  }
  return { ok: true };
}

const TRANSITION_LOCK_DIRNAME = "transition.lock";

function transitionLockDir(homeDir?: string): string {
  return resolve(restoreJobsDir(homeDir), TRANSITION_LOCK_DIRNAME);
}

type TransitionLockOwner = { jobId: string; pid: number; createdAt: string };

function parseTransitionLockOwner(value: unknown): TransitionLockOwner | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.jobId !== "string") return null;
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid)) return null;
  if (typeof record.createdAt !== "string") return null;
  return { jobId: record.jobId, pid: record.pid, createdAt: record.createdAt };
}

async function readTransitionLockOwner(lockDir: string): Promise<TransitionLockOwner | null> {
  try {
    const raw = await readFile(resolve(lockDir, "owner.json"), "utf8");
    return parseTransitionLockOwner(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readSupervisorRuntimePid(homeDir?: string): Promise<number | null> {
  try {
    const raw = await readFile(
      resolve(resolvePaperclipInstanceRoot({ homeDir }), "logs", "control-plane-runtime.pid"),
      "utf8",
    );
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export type TransitionLockAcquireResult =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; reason: string };

// mkdir-based exclusive lock, same pattern as hot-restart.ts's own
// compatibility lock. Orphan removal is intentionally narrow: a dead owner
// pid alone is never sufficient -- it must also be provably superseded by a
// *different* pid the supervisor itself has since recorded as the live
// runtime. Any failure to establish that proof refuses rather than guesses.
async function acquireTransitionLock(jobId: string, homeDir?: string): Promise<TransitionLockAcquireResult> {
  const lockDir = transitionLockDir(homeDir);
  await mkdir(dirname(lockDir), { recursive: true });

  try {
    await mkdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    const owner = await readTransitionLockOwner(lockDir);
    if (!owner) {
      return { ok: false, reason: "lock_owner_unreadable" };
    }
    if (isProcessAlive(owner.pid)) {
      return { ok: false, reason: "lock_held_by_live_process" };
    }

    const runtimePid = await readSupervisorRuntimePid(homeDir);
    if (runtimePid === null) {
      return { ok: false, reason: "orphan_check_runtime_pid_unreadable" };
    }
    if (runtimePid === owner.pid) {
      return { ok: false, reason: "orphan_check_ambiguous_runtime_pid_matches_dead_owner" };
    }

    await rm(lockDir, { recursive: true, force: true });
    try {
      await mkdir(lockDir);
    } catch {
      return { ok: false, reason: "lock_acquire_race_after_orphan_removal" };
    }
  }

  try {
    await writeFile(
      resolve(lockDir, "owner.json"),
      JSON.stringify({ jobId, pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    ok: true,
    release: async () => {
      await rm(lockDir, { recursive: true, force: true });
    },
  };
}

export type ConfirmShutdownResult =
  | { ok: true; jobId: string; state: "shutting_down" }
  | { ok: false; httpStatus: 403 | 404 | 409; code: string; message: string };

export async function confirmShutdown(input: {
  jobId: string;
  requestedBy: string;
  homeDir?: string;
  // Test-only injection seams -- both default to the real implementation.
  // No production call site passes these; they exist purely so integration
  // tests can force a specific writeSelfTargetedRestartControlRequest
  // outcome, or a specific job-file-write failure, without needing a real
  // OS-level race.
  writeRestartControlRequest?: typeof writeSelfTargetedRestartControlRequest;
  writeJobFile?: (filePath: string, job: RestoreJob) => Promise<void>;
}): Promise<ConfirmShutdownResult> {
  const { jobId, requestedBy, homeDir } = input;
  const writeRestartControlRequestImpl = input.writeRestartControlRequest ?? writeSelfTargetedRestartControlRequest;
  const writeJobFileImpl = input.writeJobFile ?? writeJobFileAtomic;

  if (!isDatabaseRestoreExecutionEnabled()) {
    return {
      ok: false,
      httpStatus: 403,
      code: "restore_execution_disabled",
      message: "Database restore execution is disabled",
    };
  }

  const capability = await checkSupervisorCapability(homeDir);
  if (!capability.ok) {
    return {
      ok: false,
      httpStatus: 409,
      code: `no_supervisor_coverage_${capability.reason}`,
      message: "No supervisor coverage for this process; refusing to request a self-shutdown",
    };
  }

  const lock = await acquireTransitionLock(jobId, homeDir);
  if (!lock.ok) {
    return {
      ok: false,
      httpStatus: 409,
      code: `transition_lock_unavailable_${lock.reason}`,
      message: "Could not acquire the restore-job transition lock",
    };
  }

  const finalPath = activeJobPath(homeDir);
  let job: RestoreJob;
  try {
    const raw = await readFile(finalPath, "utf8");
    job = JSON.parse(raw);
  } catch {
    await lock.release();
    return { ok: false, httpStatus: 404, code: "no_active_job", message: "No active restore job" };
  }

  if (job.jobId !== jobId) {
    await lock.release();
    return { ok: false, httpStatus: 404, code: "job_id_mismatch", message: "No active job with that id" };
  }
  if (job.state !== "accepted") {
    await lock.release();
    return {
      ok: false,
      httpStatus: 409,
      code: "job_not_accepted",
      message: `Job is in state ${job.state}, not accepted`,
    };
  }

  await writeJobFileImpl(finalPath, { ...job, state: "shutting_down", updatedAt: new Date().toISOString() });

  const writeResult = await writeRestartControlRequestImpl({
    reason: `database_restore_job:${jobId}`,
    requestedBy,
    homeDir,
  });

  if (writeResult.outcome === "published") {
    await lock.release();
    return { ok: true, jobId, state: "shutting_down" };
  }

  if (writeResult.outcome === "definite_no_publish") {
    // The restart-control request was definitely never published -- safe to
    // roll the job back to accepted while still holding the transition lock,
    // then release it. A later confirm attempt can retry cleanly. If this
    // rollback write itself fails (a nested failure), the throw propagates
    // out of confirmShutdown without releasing the lock and without this
    // function reporting any outcome at all -- never a false "accepted" or
    // false success.
    await writeJobFileImpl(finalPath, { ...job, updatedAt: new Date().toISOString() });
    await lock.release();
    return {
      ok: false,
      httpStatus: 409,
      code: "restart_request_not_published",
      message: "Could not publish the restart-control request; job restored to accepted",
    };
  }

  // Ambiguous: we cannot prove whether the restart-control request was
  // published or not. Never guess -- leave the job as shutting_down and keep
  // the transition lock held (not released) so no further confirm attempt
  // can race in. This requires manual operator review.
  return {
    ok: false,
    httpStatus: 409,
    code: "restart_request_publish_ambiguous",
    message: "Could not confirm whether the restart-control request was published; manual review required",
  };
}

export const MAX_RESTORE_ATTEMPTS = 2;

function normalizeLegacyRestoreAttempts(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

type ActiveJobForResume = {
  jobId: string;
  backupId: string;
  manifestSha256: string;
  state: ActiveRestoreJobState;
  requestedBy: string;
  requestedAt: string;
  restoreAttempts: number | null;
};

function parseActiveJobForResume(raw: unknown): ActiveJobForResume | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.jobId !== "string") return null;
  if (typeof record.backupId !== "string") return null;
  if (typeof record.manifestSha256 !== "string") return null;
  if (record.state !== "accepted" && record.state !== "shutting_down" && record.state !== "restoring") return null;
  if (typeof record.requestedBy !== "string") return null;
  if (typeof record.requestedAt !== "string") return null;
  return {
    jobId: record.jobId,
    backupId: record.backupId,
    manifestSha256: record.manifestSha256,
    state: record.state,
    requestedBy: record.requestedBy,
    requestedAt: record.requestedAt,
    restoreAttempts: normalizeLegacyRestoreAttempts(record.restoreAttempts),
  };
}

const FIXED_ERROR_MESSAGES = {
  journal_query_failed: "Could not query the restore journal; manual review required",
  journal_mismatch: "Restore journal entry does not match the expected backup; manual review required",
  retry_limit_exceeded: "Restore attempt limit reached without a matching journal entry; manual review required",
  journal_missing_after_restore: "No matching journal entry found after the restore completed; manual review required",
  restore_failed: "Database restore failed; manual review required",
} as const;

function fixedError(code: keyof typeof FIXED_ERROR_MESSAGES): { code: string; message: string } {
  return { code, message: FIXED_ERROR_MESSAGES[code] };
}

function archiveFilePath(jobId: string, homeDir?: string): string {
  return resolve(restoreJobsDir(homeDir), "archive", `${jobId}.json`);
}

type ArchiveTerminalInput = {
  jobId: string;
  backupId: string;
  manifestSha256: string;
  requestedBy: string;
  requestedAt: string;
  restoreAttempts: number;
};

type ArchiveTerminalOutcome = { releaseLock: true } | { releaseLock: false; code: string };

// Real implementation of the archive write, isolated behind an injectable
// seam purely so tests can force terminal_archive_write_ambiguous
// deterministically (an injected override throwing) instead of relying on an
// OS-level file-locking trick. Production code never passes an override.
async function defaultWriteArchiveFile(archivePath: string, candidate: TerminalRestoreJobRecord): Promise<void> {
  const archiveDir = dirname(archivePath);
  const tempPath = archivePath + "." + process.pid + "." + Date.now() + ".tmp";
  await mkdir(archiveDir, { recursive: true });
  try {
    await writeFile(tempPath, JSON.stringify(candidate, null, 2) + "\n", "utf8");
    await rename(tempPath, archivePath);
  } catch (error) {
    await unlink(tempPath).catch(function () { return undefined; });
    throw error;
  }
}

type ArchiveTerminalDeps = {
  writeArchiveFile?: (archivePath: string, candidate: TerminalRestoreJobRecord) => Promise<void>;
  removeActiveJobFile?: (activeJobFilePath: string) => Promise<void>;
};

async function archiveTerminal(
  job: ArchiveTerminalInput,
  state: TerminalRestoreJobState,
  lastError: { code: string; message: string } | null,
  homeDir?: string,
  deps: ArchiveTerminalDeps = {},
): Promise<ArchiveTerminalOutcome> {
  const writeArchiveFileImpl = deps.writeArchiveFile ?? defaultWriteArchiveFile;
  const removeActiveJobFileImpl = deps.removeActiveJobFile ?? ((p: string) => unlink(p));

  const archivePath = archiveFilePath(job.jobId, homeDir);
  const candidate: TerminalRestoreJobRecord = {
    version: 1,
    jobId: job.jobId,
    backupId: job.backupId,
    manifestSha256: job.manifestSha256,
    state,
    requestedBy: job.requestedBy,
    requestedAt: job.requestedAt,
    updatedAt: new Date().toISOString(),
    restoreAttempts: job.restoreAttempts,
    lastError,
  };

  let existing: Record<string, unknown> | undefined;
  try {
    const raw = await readFile(archivePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { releaseLock: false, code: "terminal_archive_conflict" };
    }
    existing = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { releaseLock: false, code: "terminal_archive_conflict" };
    }
    existing = undefined;
  }

  if (existing !== undefined) {
    const identityMatches =
      existing.version === 1
      && existing.jobId === job.jobId
      && existing.backupId === job.backupId
      && existing.manifestSha256 === job.manifestSha256
      && existing.state === state;
    if (!identityMatches) {
      return { releaseLock: false, code: "terminal_archive_conflict" };
    }
  } else {
    try {
      await writeArchiveFileImpl(archivePath, candidate);
    } catch {
      return { releaseLock: false, code: "terminal_archive_write_ambiguous" };
    }
  }

  try {
    await removeActiveJobFileImpl(activeJobPath(homeDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { releaseLock: true };
    }
    return { releaseLock: false, code: "active_job_cleanup_ambiguous" };
  }

  return { releaseLock: true };
}

type RunResumeCriticalSectionDeps = {
  writeJobFile?: (filePath: string, job: RestoreJob) => Promise<void>;
  writeArchiveFile?: (archivePath: string, candidate: TerminalRestoreJobRecord) => Promise<void>;
  removeActiveJobFile?: (activeJobFilePath: string) => Promise<void>;
};

async function runResumeCriticalSection(
  job: ActiveJobForResume,
  lock: { release: () => Promise<void> },
  connectionString: string,
  backupDir: string,
  homeDir: string | undefined,
  queryJournalEntryImpl: typeof queryRestoreJournalEntry,
  runRestoreImpl: typeof runDatabaseRestore,
  deps: RunResumeCriticalSectionDeps = {},
): Promise<void> {
  const writeJobFileImpl = deps.writeJobFile ?? writeJobFileAtomic;

  async function finalize(
    state: TerminalRestoreJobState,
    lastError: { code: string; message: string } | null,
    restoreAttempts: number,
  ) {
    const outcome = await archiveTerminal(
      {
        jobId: job.jobId,
        backupId: job.backupId,
        manifestSha256: job.manifestSha256,
        requestedBy: job.requestedBy,
        requestedAt: job.requestedAt,
        restoreAttempts: restoreAttempts,
      },
      state,
      lastError,
      homeDir,
      {
        writeArchiveFile: deps.writeArchiveFile,
        removeActiveJobFile: deps.removeActiveJobFile,
      },
    );
    if (outcome.releaseLock) {
      await lock.release();
    } else {
      logger.error({ jobId: job.jobId, code: outcome.code });
    }
  }

  let journalEntry: Awaited<ReturnType<typeof queryRestoreJournalEntry>>;
  try {
    journalEntry = await queryJournalEntryImpl(connectionString, job.jobId);
  } catch {
    await finalize("failed", fixedError("journal_query_failed"), job.restoreAttempts === null ? 0 : job.restoreAttempts);
    return;
  }

  if (journalEntry !== null) {
    if (
      journalEntry.jobId === job.jobId
      && journalEntry.backupId === job.backupId
      && journalEntry.manifestSha256 === job.manifestSha256
    ) {
      await finalize("succeeded", null, job.restoreAttempts === null ? 0 : job.restoreAttempts);
    } else {
      await finalize("failed", fixedError("journal_mismatch"), job.restoreAttempts === null ? 0 : job.restoreAttempts);
    }
    return;
  }

  if (job.restoreAttempts === null || job.restoreAttempts >= MAX_RESTORE_ATTEMPTS) {
    await finalize("failed", fixedError("retry_limit_exceeded"), job.restoreAttempts === null ? MAX_RESTORE_ATTEMPTS : job.restoreAttempts);
    return;
  }

  const nextAttempts = job.restoreAttempts + 1;

  await writeJobFileImpl(activeJobPath(homeDir), {
    version: 1,
    jobId: job.jobId,
    backupId: job.backupId,
    manifestSha256: job.manifestSha256,
    state: "restoring",
    requestedBy: job.requestedBy,
    requestedAt: job.requestedAt,
    updatedAt: new Date().toISOString(),
    restoreAttempts: nextAttempts,
  });

  try {
    await runRestoreImpl({
      backupFile: resolve(backupDir, job.backupId),
      connectionString: connectionString,
      verifyManifestBeforeRestore: true,
      forceJavaScriptEngine: true,
      sentinel: {
        jobId: job.jobId,
        backupId: job.backupId,
        manifestSha256: job.manifestSha256,
      },
    });
  } catch {
    await finalize("failed", fixedError("restore_failed"), nextAttempts);
    return;
  }

  let confirmEntry: Awaited<ReturnType<typeof queryRestoreJournalEntry>>;
  try {
    confirmEntry = await queryJournalEntryImpl(connectionString, job.jobId);
  } catch {
    await finalize("failed", fixedError("journal_query_failed"), nextAttempts);
    return;
  }

  if (confirmEntry === null) {
    await finalize("failed", fixedError("journal_missing_after_restore"), nextAttempts);
    return;
  }

  if (
    confirmEntry.jobId !== job.jobId
    || confirmEntry.backupId !== job.backupId
    || confirmEntry.manifestSha256 !== job.manifestSha256
  ) {
    await finalize("failed", fixedError("journal_mismatch"), nextAttempts);
    return;
  }

  await finalize("succeeded", null, nextAttempts);
}

export async function resumeDatabaseRestoreIfNeeded(input: {
  connectionString: string;
  backupDir: string;
  homeDir?: string;
  // Test-only injection seams -- all default to the real implementation. No
  // production call site passes these.
  queryJournalEntry?: typeof queryRestoreJournalEntry;
  runRestore?: typeof runDatabaseRestore;
  acquireLock?: typeof acquireTransitionLock;
  readActiveJobFile?: (filePath: string) => Promise<string>;
  writeJobFile?: (filePath: string, job: RestoreJob) => Promise<void>;
  writeArchiveFile?: (archivePath: string, candidate: TerminalRestoreJobRecord) => Promise<void>;
  removeActiveJobFile?: (activeJobFilePath: string) => Promise<void>;
}): Promise<void> {
  if (!isDatabaseRestoreExecutionEnabled()) return;

  const queryJournalEntryImpl = input.queryJournalEntry ?? queryRestoreJournalEntry;
  const runRestoreImpl = input.runRestore ?? runDatabaseRestore;
  const acquireLockImpl = input.acquireLock ?? acquireTransitionLock;
  const readActiveJobFileImpl = input.readActiveJobFile ?? ((p: string) => readFile(p, "utf8"));
  const finalPath = activeJobPath(input.homeDir);

  let raw: string;
  try {
    raw = await readActiveJobFileImpl(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    logger.warn({ code: "active_restore_job_unreadable" });
    return;
  }

  let job: ActiveJobForResume | null;
  try {
    job = parseActiveJobForResume(JSON.parse(raw));
  } catch {
    logger.warn({ code: "active_restore_job_unreadable" });
    return;
  }

  if (job === null) {
    logger.warn({ code: "active_restore_job_unreadable" });
    return;
  }

  if (job.state !== "shutting_down" && job.state !== "restoring") {
    return;
  }

  let lock: TransitionLockAcquireResult;
  try {
    lock = await acquireLockImpl(job.jobId, input.homeDir);
  } catch {
    logger.warn({ jobId: job.jobId, code: "restore_lock_acquisition_failed" });
    return;
  }

  if (!lock.ok) {
    logger.warn({ jobId: job.jobId, code: "restore_lock_unavailable", reason: lock.reason });
    return;
  }

  try {
    await runResumeCriticalSection(
      job,
      lock,
      input.connectionString,
      input.backupDir,
      input.homeDir,
      queryJournalEntryImpl,
      runRestoreImpl,
      {
        writeJobFile: input.writeJobFile,
        writeArchiveFile: input.writeArchiveFile,
        removeActiveJobFile: input.removeActiveJobFile,
      },
    );
  } catch {
    logger.error({ jobId: job.jobId, code: "restore_resume_unexpected_error" });
  }
}
