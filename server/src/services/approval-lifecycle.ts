import { createHash } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalActionIdempotencyKeys, approvals } from "@paperclipai/db";
import type { PreExecutionRisk } from "./heartbeat.js";

export type ApprovalRecord = typeof approvals.$inferSelect;

// HIGH is fixed at 15 minutes per Human decision. UNKNOWN is treated as
// conservatively as HIGH (fail-safe default) — Risk Guard already blocks
// UNKNOWN exactly like HIGH before execution, so its authorization window
// should not outlive HIGH's. LOW never reaches this function in practice:
// classifyPreExecutionRisk's LOW result never triggers interceptedByRiskGuard,
// so no LOW-risk risk_guard approval is ever created — kept here only so the
// function is total over PreExecutionRisk.
const APPROVAL_TTL_MS_BY_RISK: Record<PreExecutionRisk, number | null> = {
  HIGH: 15 * 60 * 1000,
  UNKNOWN: 15 * 60 * 1000,
  LOW: null,
};

export function approvalTtlMsForRisk(risk: PreExecutionRisk): number | null {
  return APPROVAL_TTL_MS_BY_RISK[risk];
}

/**
 * The fingerprint binds an approval to the exact content a Human reviewed:
 * which company/issue/agent it's for, the classified risk, and the
 * normalized task text. If any of these change after approval, the fingerprint
 * no longer matches and the old approval can never again authorize execution
 * (see consumeApproval below) — Risk Guard must re-intercept and create a
 * fresh pending approval instead. Deliberately excludes execution settings
 * (adapter/model profile) and "which files will change" — the former isn't
 * something a Human reviews, and the latter isn't knowable before execution.
 */
export function computeApprovalFingerprint(input: {
  companyId: string;
  issueId: string | null;
  requestedByAgentId: string | null;
  risk: PreExecutionRisk;
  taskText: string;
}): string {
  const canonical = JSON.stringify({
    companyId: input.companyId,
    issueId: input.issueId,
    requestedByAgentId: input.requestedByAgentId,
    risk: input.risk,
    taskText: input.taskText,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export type EffectiveApprovalStatus =
  | "pending"
  | "revision_requested"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "consumed";

/**
 * Pure, read-time-derived status. No sweep job, no write — `status` on the
 * row never changes because of TTL/consumption, so there is no race between
 * "a sweep marked it expired" and "someone just approved it": every reader
 * computes the same answer from the same row at the moment it reads it.
 */
export function effectiveApprovalStatus(
  approval: Pick<ApprovalRecord, "status" | "expiresAt" | "consumedAt">,
  now: Date = new Date(),
): EffectiveApprovalStatus {
  if (approval.status === "cancelled" || approval.status === "rejected") {
    return approval.status;
  }
  if (
    (approval.status === "pending" || approval.status === "revision_requested") &&
    approval.expiresAt != null &&
    approval.expiresAt.getTime() <= now.getTime()
  ) {
    return "expired";
  }
  if (approval.status === "approved" && approval.consumedAt != null) {
    return "consumed";
  }
  return approval.status as EffectiveApprovalStatus;
}

export type FingerprintStatus = "current" | "stale" | "not_applicable";

/**
 * "stale" only ever becomes true once heartbeat.ts's resume path (a separate,
 * not-yet-approved change) starts populating supersededByApprovalId. Until
 * then this always resolves to "current" or "not_applicable" — an honest
 * reflection of what has actually landed, not a promise of what hasn't.
 */
export function fingerprintStatus(
  approval: Pick<ApprovalRecord, "taskFingerprint" | "supersededByApprovalId">,
): FingerprintStatus {
  if (approval.taskFingerprint == null) return "not_applicable";
  return approval.supersededByApprovalId == null ? "current" : "stale";
}

export type ConsumeApprovalOutcome =
  | "consumed"
  | "already_consumed_same_run"
  | "already_consumed_other_run"
  | "approval_not_found"
  | "approval_not_approved"
  | "approval_expired"
  | "fingerprint_mismatch"
  | "approval_superseded"
  | "inconsistent_state";

export interface ConsumeApprovalResult {
  outcome: ConsumeApprovalOutcome;
  approval: ApprovalRecord | null;
}

/**
 * Consumes an approval for exactly one execution run, atomically. Every
 * security precondition (approved status, live TTL, matching fingerprint,
 * not superseded, not already consumed) is evaluated inside the SAME
 * conditional UPDATE that records the consumption — there is no window
 * between "we checked it was valid" and "we recorded it was used" in which
 * another transaction could invalidate the approval (reject/expire/supersede
 * it). If the UPDATE affects a row, every one of those conditions was true at
 * that instant; that is the only source of truth this function trusts.
 *
 * Only a retry from the SAME runId with the SAME (still current, still
 * non-superseded) fingerprint is treated as an idempotent success. Any other
 * runId is rejected outright, even with a matching fingerprint — an approval
 * authorizes exactly one execution run, never a second one, no matter how
 * "equivalent" the second run's request looks.
 */
export async function consumeApproval(
  db: Db,
  input: { approvalId: string; runId: string; expectedTaskFingerprint: string },
): Promise<ConsumeApprovalResult> {
  const now = new Date();

  const updated = await db
    .update(approvals)
    .set({ consumedAt: now, consumedByRunId: input.runId, updatedAt: now })
    .where(
      and(
        eq(approvals.id, input.approvalId),
        eq(approvals.status, "approved"),
        isNull(approvals.consumedAt),
        eq(approvals.taskFingerprint, input.expectedTaskFingerprint),
        isNull(approvals.supersededByApprovalId),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);

  if (updated) {
    return { outcome: "consumed", approval: updated };
  }

  const existing = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, input.approvalId))
    .then((rows) => rows[0] ?? null);

  if (!existing) {
    return { outcome: "approval_not_found", approval: null };
  }
  if (existing.status !== "approved") {
    return { outcome: "approval_not_approved", approval: existing };
  }
  if (existing.taskFingerprint !== input.expectedTaskFingerprint) {
    return { outcome: "fingerprint_mismatch", approval: existing };
  }
  if (existing.supersededByApprovalId !== null) {
    return { outcome: "approval_superseded", approval: existing };
  }

  if (existing.consumedAt && existing.consumedByRunId) {
    if (existing.consumedByRunId === input.runId) {
      return { outcome: "already_consumed_same_run", approval: existing };
    }
    return { outcome: "already_consumed_other_run", approval: existing };
  }

  return { outcome: "inconsistent_state", approval: existing };
}

export type ApprovalIdempotencyAction = "approve" | "reject" | "request_revision";

const APPROVAL_IDEMPOTENCY_KEY_RETENTION_MS = 24 * 60 * 60 * 1000;
const APPROVAL_IDEMPOTENCY_KEY_CLEANUP_BATCH_SIZE = 200;

// "board_key:<keyId>" for a paired device/CLI key, "user:<userId>" for a
// session/local_implicit board actor. Never the raw bearer token or hash —
// mirrors boardKeySourceDetails(req)'s existing convention in
// routes/approvals.ts.
export function actorIdentityFor(req: { actor: { source?: string; keyId?: string; userId?: string } }): string {
  if (req.actor.source === "board_key" && req.actor.keyId) {
    return `board_key:${req.actor.keyId}`;
  }
  return `user:${req.actor.userId ?? "unknown"}`;
}

export function requestFingerprintFor(input: { decisionNote?: string | null }): string {
  return createHash("sha256").update(JSON.stringify({ decisionNote: input.decisionNote ?? null })).digest("hex");
}

export type IdempotentLookup =
  | { kind: "replay"; httpStatus: number; body: unknown }
  | { kind: "key_reused_with_different_request" }
  | { kind: "none" };

/**
 * Read-only fast path — call only AFTER access checks pass. A row with
 * status !== "completed" can only be a claim from a still-in-flight
 * concurrent transaction we can't yet see the outcome of; treated the same
 * as "none" so the caller falls through to the real claim attempt, which
 * correctly blocks on that race at the database level.
 */
export async function checkApprovalIdempotency(
  db: Db,
  input: {
    actorIdentity: string;
    idempotencyKey: string;
    approvalId: string;
    action: ApprovalIdempotencyAction;
    requestFingerprint: string;
  },
): Promise<IdempotentLookup> {
  const existing = await db
    .select()
    .from(approvalActionIdempotencyKeys)
    .where(
      and(
        eq(approvalActionIdempotencyKeys.actorIdentity, input.actorIdentity),
        eq(approvalActionIdempotencyKeys.idempotencyKey, input.idempotencyKey),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (!existing || existing.status !== "completed") return { kind: "none" };

  if (
    existing.approvalId !== input.approvalId ||
    existing.action !== input.action ||
    existing.requestFingerprint !== input.requestFingerprint
  ) {
    return { kind: "key_reused_with_different_request" };
  }
  return { kind: "replay", httpStatus: existing.httpStatus!, body: JSON.parse(existing.responseBody!) };
}

export type ClaimedIdempotency =
  | { kind: "won"; claimId: string }
  | { kind: "lost_replay"; httpStatus: number; body: unknown }
  | { kind: "lost_conflict" };

/**
 * MUST run inside the caller's transaction. Postgres blocks this INSERT's
 * ON CONFLICT resolution until any concurrent transaction holding the same
 * (actorIdentity, idempotencyKey) row finishes (commit or rollback) — so a
 * "lost" result here is only reachable once the winner has fully committed,
 * meaning the re-select below can never observe a still-"reserved" row.
 */
export async function claimApprovalIdempotency(
  tx: Db,
  input: {
    companyId: string;
    actorIdentity: string;
    idempotencyKey: string;
    approvalId: string;
    action: ApprovalIdempotencyAction;
    requestFingerprint: string;
  },
): Promise<ClaimedIdempotency> {
  await tx.execute(sql`
    delete from ${approvalActionIdempotencyKeys}
    where ${approvalActionIdempotencyKeys.id} in (
      select ${approvalActionIdempotencyKeys.id}
      from ${approvalActionIdempotencyKeys}
      where ${approvalActionIdempotencyKeys.companyId} = ${input.companyId}
        and ${approvalActionIdempotencyKeys.expiresAt} < now()
      order by ${approvalActionIdempotencyKeys.expiresAt} asc, ${approvalActionIdempotencyKeys.id} asc
      limit ${APPROVAL_IDEMPOTENCY_KEY_CLEANUP_BATCH_SIZE}
    )
  `);

  const expiresAt = new Date(Date.now() + APPROVAL_IDEMPOTENCY_KEY_RETENTION_MS);
  const claimed = await tx
    .insert(approvalActionIdempotencyKeys)
    .values({
      companyId: input.companyId,
      actorIdentity: input.actorIdentity,
      idempotencyKey: input.idempotencyKey,
      approvalId: input.approvalId,
      action: input.action,
      requestFingerprint: input.requestFingerprint,
      status: "reserved",
      httpStatus: null,
      responseBody: null,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: approvalActionIdempotencyKeys.id })
    .then((rows) => rows[0] ?? null);

  if (claimed) return { kind: "won", claimId: claimed.id };

  const existing = await tx
    .select()
    .from(approvalActionIdempotencyKeys)
    .where(
      and(
        eq(approvalActionIdempotencyKeys.actorIdentity, input.actorIdentity),
        eq(approvalActionIdempotencyKeys.idempotencyKey, input.idempotencyKey),
      ),
    )
    .then((rows) => rows[0]!);

  if (
    existing.approvalId !== input.approvalId ||
    existing.action !== input.action ||
    existing.requestFingerprint !== input.requestFingerprint
  ) {
    return { kind: "lost_conflict" };
  }
  return { kind: "lost_replay", httpStatus: existing.httpStatus!, body: JSON.parse(existing.responseBody!) };
}

/** MUST run inside the same transaction as claimApprovalIdempotency. */
export async function completeApprovalIdempotency(
  tx: Db,
  input: { claimId: string; httpStatus: number; body: unknown },
): Promise<void> {
  await tx
    .update(approvalActionIdempotencyKeys)
    .set({
      status: "completed",
      httpStatus: input.httpStatus,
      responseBody: JSON.stringify(input.body),
      completedAt: new Date(),
    })
    .where(eq(approvalActionIdempotencyKeys.id, input.claimId));
}
