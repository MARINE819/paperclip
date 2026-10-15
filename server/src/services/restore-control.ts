import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { verifyBackupManifest } from "@paperclipai/db/backup-lib";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

// This batch only ever writes/reads the "accepted" state. No code here
// triggers a shutdown, a restore, an OS recovery lock, or a journal lookup
// -- those are later, separately-gated batches.
export type RestoreJobState = "accepted";

// Deliberately holds no absolute paths, connection strings, or secrets --
// only a bare backup filename and a server-derived manifest hash.
export type RestoreJob = {
  version: 1;
  jobId: string;
  backupId: string;
  manifestSha256: string;
  state: RestoreJobState;
  requestedBy: string;
  requestedAt: string;
  updatedAt: string;
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
