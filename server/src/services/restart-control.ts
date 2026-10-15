import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { getServerInfoSnapshot } from "../server-info.js";

const RESTART_CONTROL_AUDIT_FILENAME = "restart-control-audit.jsonl";
const DEFAULT_TTL_MS = 5 * 60 * 1000;
// A request timestamped more than this far in the future is clock-skew, not a
// legitimate just-created request; treated as stale rather than honored.
const MAX_CLOCK_SKEW_MS = 30_000;

export type RestartControlRequest = {
  version: 1;
  requestId: string;
  createdAt: string;
  requestedBy: string;
  reason: string;
  targetProcessStartedAt: string | null;
  targetPid: number | null;
};

export type RestartControlDecision =
  | { action: "none" }
  | { action: "shutdown"; request: RestartControlRequest }
  | { action: "ignored"; reason: string; request: RestartControlRequest | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

// PID-scoped, not a single shared name: each running process polls only the
// path bearing its own PID, so a process that is not the intended target can
// never see, claim, or consume a request meant for a different PID (see the
// cross-process race this replaced — RESTART_CONTROL_MULTI_PROCESS_RACE).
export function resolveRestartControlRequestPath(targetPid: number, homeDir?: string): string {
  return path.join(
    resolvePaperclipInstanceRoot({ homeDir }),
    `restart-control-request.${targetPid}.json`,
  );
}

function resolveRestartControlAuditPath(homeDir?: string): string {
  return path.join(resolvePaperclipInstanceRoot({ homeDir }), "logs", RESTART_CONTROL_AUDIT_FILENAME);
}

// Requires at least one of targetProcessStartedAt/targetPid so a request can
// never be honored without checking it against a real running process's
// identity (see consumeRestartControlRequest's target-match check below).
export function parseRestartControlRequest(value: unknown): RestartControlRequest | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const requestId = asString(value.requestId);
  const createdAt = asString(value.createdAt);
  const requestedBy = asString(value.requestedBy);
  const reason = asString(value.reason);
  if (!requestId || !createdAt || !requestedBy || !reason) return null;
  if (!Number.isFinite(Date.parse(createdAt))) return null;

  const targetProcessStartedAt = asString(value.targetProcessStartedAt);
  const targetPid = asNumber(value.targetPid);
  if (targetProcessStartedAt === null && targetPid === null) return null;

  return { version: 1, requestId, createdAt, requestedBy, reason, targetProcessStartedAt, targetPid };
}

async function appendAuditLog(
  homeDir: string | undefined,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    const auditPath = resolveRestartControlAuditPath(homeDir);
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.appendFile(
      auditPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch {
    // Audit logging must never block or fail the actual restart decision.
  }
}

// Atomically renames the well-known request path to a claim-scoped temp path.
// This is the step that makes replay impossible: once claimed, the file no
// longer exists at the well-known path, so no concurrent poll tick (in this
// process or, after a restart, in the replacement process) can ever see or
// act on the same file again — regardless of whether it turns out to be
// valid, stale, or malformed once inspected.
async function claimRestartControlRequestFile(targetPid: number, homeDir?: string): Promise<string | null> {
  const requestPath = resolveRestartControlRequestPath(targetPid, homeDir);
  const claimedPath = `${requestPath}.${process.pid}.${Date.now()}.claimed`;
  try {
    await fs.rename(requestPath, claimedPath);
    return claimedPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function consumeRestartControlRequest(input: {
  currentPid: number;
  currentProcessStartedAt: string;
  now?: Date;
  ttlMs?: number;
  homeDir?: string;
}): Promise<RestartControlDecision> {
  const claimedPath = await claimRestartControlRequestFile(input.currentPid, input.homeDir);
  if (!claimedPath) return { action: "none" };

  let raw: string;
  try {
    raw = await fs.readFile(claimedPath, "utf8");
  } finally {
    await fs.unlink(claimedPath).catch(() => undefined);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    await appendAuditLog(input.homeDir, { event: "ignored", reason: "malformed_json" });
    return { action: "ignored", reason: "malformed_json", request: null };
  }

  const request = parseRestartControlRequest(parsedJson);
  if (!request) {
    await appendAuditLog(input.homeDir, { event: "ignored", reason: "malformed_shape" });
    return { action: "ignored", reason: "malformed_shape", request: null };
  }

  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const ageMs = now.getTime() - Date.parse(request.createdAt);
  if (!Number.isFinite(ageMs) || ageMs > ttlMs || ageMs < -MAX_CLOCK_SKEW_MS) {
    await appendAuditLog(input.homeDir, {
      event: "ignored",
      reason: "stale",
      requestId: request.requestId,
      ageMs,
      ttlMs,
    });
    return { action: "ignored", reason: "stale", request };
  }

  const pidMatches = request.targetPid === null || request.targetPid === input.currentPid;
  const identityMatches =
    request.targetProcessStartedAt === null
    || request.targetProcessStartedAt === input.currentProcessStartedAt;
  if (!pidMatches || !identityMatches) {
    await appendAuditLog(input.homeDir, {
      event: "ignored",
      reason: "target_mismatch",
      requestId: request.requestId,
      targetPid: request.targetPid,
      targetProcessStartedAt: request.targetProcessStartedAt,
      currentPid: input.currentPid,
      currentProcessStartedAt: input.currentProcessStartedAt,
    });
    return { action: "ignored", reason: "target_mismatch", request };
  }

  await appendAuditLog(input.homeDir, {
    event: "accepted",
    requestId: request.requestId,
    requestedBy: request.requestedBy,
    reason: request.reason,
  });
  return { action: "shutdown", request };
}

export type RestartControlRequestWriteOutcome =
  | { outcome: "published"; request: RestartControlRequest }
  | { outcome: "definite_no_publish"; error: unknown }
  | { outcome: "ambiguous"; error: unknown };

// Test-only injection seam (same pattern as hot-restart.ts's
// ProcessCommandRunner/ProcessStatReader): lets tests force a specific fs
// call to fail without needing a real OS-level race, while every other call
// still goes through the real node:fs/promises implementation.
export type RestartControlRequestFsOverrides = {
  mkdir?: typeof fs.mkdir;
  writeFile?: typeof fs.writeFile;
  rename?: typeof fs.rename;
  readFile?: typeof fs.readFile;
  unlink?: typeof fs.unlink;
};

// Only a literal ENOENT on the post-failure read counts as proof the file
// does not exist. Any other error (EACCES/EPERM/EBUSY/anything else) must
// never be treated as "not there" -- it means the true state is unknown.
async function classifyRestartControlRequestWriteFailure(
  requestPath: string,
  expected: RestartControlRequest,
  readFileImpl: typeof fs.readFile,
): Promise<RestartControlRequestWriteOutcome> {
  let raw: string;
  try {
    raw = (await readFileImpl(requestPath, "utf8")) as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { outcome: "definite_no_publish", error };
    }
    return { outcome: "ambiguous", error };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return { outcome: "ambiguous", error };
  }

  const parsed = parseRestartControlRequest(parsedJson);
  if (!parsed) {
    return {
      outcome: "ambiguous",
      error: new Error("restart-control request file does not match the expected shape"),
    };
  }

  // Finding *a* valid request at this path is not proof of *this call's*
  // publish -- it could be a stale, unrelated request left over from before.
  // Only an exact match on requestId + target identity counts as definite.
  const identityMatches =
    parsed.requestId === expected.requestId
    && parsed.targetPid === expected.targetPid
    && parsed.targetProcessStartedAt === expected.targetProcessStartedAt;
  if (!identityMatches) {
    return {
      outcome: "ambiguous",
      error: new Error("restart-control request file does not match this call's identity"),
    };
  }

  return { outcome: "published", request: parsed };
}

// Writes (or confirms) a restart-control request targeting *this exact
// process* (its own pid and boot identity), reusing the identical file
// format and path convention consumeRestartControlRequest already polls for.
// This function never shuts anything down itself -- it only ever writes a
// request file; the existing watcher decides whether and when to act on it.
export async function writeSelfTargetedRestartControlRequest(input: {
  reason: string;
  requestedBy: string;
  homeDir?: string;
  ttlMs?: number;
  requestId?: string;
  fsOverrides?: RestartControlRequestFsOverrides;
}): Promise<RestartControlRequestWriteOutcome> {
  const impl = {
    mkdir: input.fsOverrides?.mkdir ?? fs.mkdir,
    writeFile: input.fsOverrides?.writeFile ?? fs.writeFile,
    rename: input.fsOverrides?.rename ?? fs.rename,
    readFile: input.fsOverrides?.readFile ?? fs.readFile,
    unlink: input.fsOverrides?.unlink ?? fs.unlink,
  };

  const targetPid = process.pid;
  const requestPath = resolveRestartControlRequestPath(targetPid, input.homeDir);
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;

  // Idempotency: a still-valid request already targeting this exact process
  // means an earlier call already published one -- don't write a second one.
  try {
    const existingRaw = (await impl.readFile(requestPath, "utf8")) as string;
    const existingParsed = parseRestartControlRequest(JSON.parse(existingRaw));
    if (existingParsed && existingParsed.targetPid === targetPid) {
      const ageMs = Date.now() - Date.parse(existingParsed.createdAt);
      if (Number.isFinite(ageMs) && ageMs >= -MAX_CLOCK_SKEW_MS && ageMs <= ttlMs) {
        return { outcome: "published", request: existingParsed };
      }
    }
  } catch {
    // No existing (or unreadable/invalid) request at this path -- proceed to
    // write a fresh one.
  }

  const request: RestartControlRequest = {
    version: 1,
    requestId: input.requestId ?? randomUUID(),
    createdAt: new Date().toISOString(),
    requestedBy: input.requestedBy,
    reason: input.reason,
    targetProcessStartedAt: getServerInfoSnapshot().processStartedAt,
    targetPid,
  };

  const tempPath = `${requestPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await impl.mkdir(path.dirname(requestPath), { recursive: true });
    await impl.writeFile(tempPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  } catch (error) {
    // Rename was never attempted -- this call's content cannot possibly be
    // at requestPath, regardless of what else is there.
    return { outcome: "definite_no_publish", error };
  }

  try {
    await impl.rename(tempPath, requestPath);
    return { outcome: "published", request };
  } catch (error) {
    const classification = await classifyRestartControlRequestWriteFailure(requestPath, request, impl.readFile);
    await impl.unlink(tempPath).catch(() => undefined);
    return classification;
  }
}
