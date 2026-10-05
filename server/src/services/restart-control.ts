import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

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
