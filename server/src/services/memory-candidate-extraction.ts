import { createHash } from "node:crypto";
import { and, asc, eq, notExists, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
  memoryOperations,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { isUniqueViolation } from "../db-errors.js";
import { logger } from "../middleware/logger.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import {
  createFailureCooldownTracker,
  type FailureCooldownTracker,
} from "./memory-candidate-failure-cooldown.js";
import { getIssueContinuationSummaryDocument } from "./issue-continuation-summary.js";
import { assertOptionalCompanyReference } from "./knowledge.js";

/**
 * Deterministic Memory Operation candidate extraction from a completed
 * Issue's existing Continuation Summary document
 * (`server/src/services/issue-continuation-summary.ts`,
 * `ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY`). No AI inference, no free
 * summarization: this only reads a document that Core already writes
 * deterministically (template + regex extraction, refreshed on every
 * heartbeat run finalization) and copies its latest revision verbatim into
 * a `memory_operations` candidate row.
 *
 * Two triggers share this same insert/idempotency logic but differ in
 * eligibility scope and activity attribution:
 *
 * - **Phase 3.0A** (`extractMemoryOperationCandidateFromCompletedIssue`,
 *   called only from the explicit, Board-only
 *   `POST /api/issues/:id/extract-memory-candidate` route): a human decision
 *   to (re-)run extraction right now for one specific Issue. Idempotency is
 *   per-revision (`extractionKey` includes the revision's content hash), so
 *   calling it again after the summary changed intentionally creates an
 *   additional candidate for the new content. Attributed to the real
 *   calling Board actor, action `memory_operation.extracted`.
 * - **Phase 3.0B** (`reconcileAutomaticMemoryOperationCandidates`, wired
 *   into `server/src/app.ts`'s startup/periodic scheduler, never into
 *   `issues.ts` or `heartbeat.ts`): a durable background sweep that finds
 *   completed Issues with no continuation-summary-sourced candidate *at
 *   all* yet (see `findCompletedIssuesEligibleForAutomaticExtraction`) and
 *   extracts at most one, ever, per Issue automatically. If Phase 3.0A
 *   already produced a candidate for an Issue (by any actor), 3.0B leaves
 *   it alone — it never adds a second automatic candidate, including after
 *   a later revision of the summary appears. Attributed to
 *   `actorType: "system"`, action `memory_operation.auto_created`.
 *
 * Neither trigger bypasses Board review: every row this module inserts is
 * `status: "candidate"`, `reviewState: "pending"`.
 */

export const MEMORY_CANDIDATE_EXTRACTOR_VERSION = "continuation-summary-v1";
const AUTOMATIC_EXTRACTION_REASON = "issue_completed_continuation_summary";

export type ExtractionActor =
  | { actorType: "user" | "agent"; actorId: string; agentId: string | null; runId: string | null }
  | { actorType: "system"; actorId: string; agentId: null; runId: null };

export type MemoryCandidateExtractionOutcome =
  | { outcome: "created"; operation: typeof memoryOperations.$inferSelect }
  | { outcome: "deduplicated"; operation: typeof memoryOperations.$inferSelect }
  | {
    outcome: "skipped";
    reason: "issue_not_found" | "issue_not_done" | "no_completion_document" | "empty_document";
  };

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Exported for tests: the extraction key is deterministic from these four inputs alone. */
export function buildContinuationSummaryExtractionKey(input: {
  companyId: string;
  sourceId: string;
  contentHash: string;
}): string {
  return sha256Hex(
    `${input.companyId}|document|${input.sourceId}|${MEMORY_CANDIDATE_EXTRACTOR_VERSION}|${input.contentHash}`,
  );
}

export async function extractMemoryOperationCandidateFromCompletedIssue(
  db: Db,
  companyId: string,
  issueId: string,
  actor: ExtractionActor,
): Promise<MemoryCandidateExtractionOutcome> {
  const issue = await db
    .select({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!issue || issue.companyId !== companyId) return { outcome: "skipped", reason: "issue_not_found" };
  if (issue.status !== "done") return { outcome: "skipped", reason: "issue_not_done" };

  const summaryDoc = await getIssueContinuationSummaryDocument(db, issue.id);
  if (!summaryDoc || !summaryDoc.latestRevisionId) return { outcome: "skipped", reason: "no_completion_document" };

  // Read the specific, immutable revision rather than trusting the
  // already-fetched `summaryDoc.body` a second time — this is the one
  // query whose row becomes the candidate's exact source content, so it is
  // re-scoped to `companyId` here as well (defense in depth; the document
  // is already reached only through this company's own issue).
  const revision = await db
    .select()
    .from(documentRevisions)
    .where(and(eq(documentRevisions.id, summaryDoc.latestRevisionId), eq(documentRevisions.companyId, companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!revision || !revision.body?.trim()) return { outcome: "skipped", reason: "empty_document" };

  // Fail closed if the revision's recorded author/run somehow belongs to a
  // different company than the issue (should never happen through normal
  // Core writes, but this is the explicit boundary the candidate contract
  // requires — see `knowledgeService.createMemoryOperation`'s identical check).
  await Promise.all([
    assertOptionalCompanyReference(db, agents, revision.createdByAgentId, companyId, "sourceAgentId"),
    assertOptionalCompanyReference(db, heartbeatRuns, revision.createdByRunId, companyId, "sourceRunId"),
  ]);

  const contentHash = sha256Hex(revision.body);
  const extractionKey = buildContinuationSummaryExtractionKey({ companyId, sourceId: revision.id, contentHash });

  const values = {
    companyId,
    sourceType: "document" as const,
    sourceId: revision.id,
    sourceIssueId: issue.id,
    sourceRunId: revision.createdByRunId ?? null,
    sourceAgentId: revision.createdByAgentId ?? null,
    title: `${issue.identifier ?? issue.id} — Continuation Summary`,
    summary: null,
    content: revision.body,
    confidence: null,
    extractionKey,
    metadata: {
      extractorVersion: MEMORY_CANDIDATE_EXTRACTOR_VERSION,
      extractionReason: AUTOMATIC_EXTRACTION_REASON,
      sourceSnapshot: {
        documentId: revision.documentId,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        issueId: issue.id,
      },
      extractedAt: new Date().toISOString(),
      contentHash,
    },
  };

  try {
    // The candidate row and its activity log entry commit together: if the
    // activity insert failed after the candidate insert succeeded, a retry
    // would find the extractionKey already taken and report "deduplicated"
    // — permanently losing the log entry for a candidate that genuinely
    // exists. Putting both writes in one transaction makes that failure
    // mode impossible: either both rows exist, or neither does and the next
    // call performs a completely fresh (non-deduplicated) creation.
    const { operation, publication } = await db.transaction(async (tx) => {
      const [created] = await tx.insert(memoryOperations).values(values).returning();
      const { publication: pub } = await persistActivity(tx as unknown as Db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: actor.actorType === "system" ? "memory_operation.auto_created" : "memory_operation.extracted",
        entityType: "memory_operation",
        entityId: created!.id,
        issueId: issue.id,
        details: {
          sourceType: created!.sourceType,
          sourceId: created!.sourceId,
          extractionKey: created!.extractionKey,
          extractorVersion: MEMORY_CANDIDATE_EXTRACTOR_VERSION,
        },
      });
      return { operation: created!, publication: pub };
    });
    // Only after commit: publishActivity is a non-transactional, in-memory
    // side effect (live-event broadcast, plugin event), never a DB write —
    // it must never run inside the transaction and never run if the
    // transaction rolled back.
    publishActivity(publication);
    return { outcome: "created", operation };
  } catch (error) {
    if (isUniqueViolation(error, "memory_operations_company_extraction_key_uq")) {
      const [existing] = await db
        .select()
        .from(memoryOperations)
        .where(and(eq(memoryOperations.companyId, companyId), eq(memoryOperations.extractionKey, extractionKey)))
        .limit(1);
      // The row must exist — the violation means another call already
      // committed it (candidate + its activity log entry together, per the
      // transaction above) — but fail loudly rather than silently if it
      // somehow does not, instead of masking a real bug as "deduplicated".
      if (existing) return { outcome: "deduplicated", operation: existing };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Phase 3.0B: durable automatic reconciliation
// ---------------------------------------------------------------------------

/** Attributed actorId for every automatically created candidate (see module doc). */
export const MEMORY_CANDIDATE_RECONCILER_SYSTEM_ACTOR_ID = "memory-candidate-reconciler";

const SYSTEM_ACTOR: ExtractionActor = {
  actorType: "system",
  actorId: MEMORY_CANDIDATE_RECONCILER_SYSTEM_ACTOR_ID,
  agentId: null,
  runId: null,
};

/** How much larger than `batchSize` the per-tick scan window is, by default. */
const DEFAULT_SCAN_LIMIT_MULTIPLIER = 5;
const MAX_SCAN_LIMIT = 500;

export interface EligibleCompletedIssue {
  issueId: string;
  companyId: string;
}

/**
 * The durable, migration-free eligibility query (see the module doc on
 * `doc/memory-candidate-extraction.md` for the full derivation): a completed
 * Issue whose continuation-summary document's latest revision has real
 * content, and for which no continuation-summary-sourced Memory Operation
 * exists yet for that Issue — from *either* Phase 3.0A or 3.0B, so an
 * automatic sweep never adds a second candidate next to one a Board actor
 * already created, and never adds a second one of its own after a later
 * revision appears (see `AUTOMATIC_EXTRACTION_REASON`, matched regardless of
 * which actor produced the existing row).
 *
 * Ordering is deterministic (`COALESCE(completedAt, updatedAt, createdAt)`
 * then `id`) so an imported Issue with a null `completedAt` still sorts
 * stably instead of being skipped or duplicated across ticks. No OFFSET
 * pagination: each call re-derives eligibility fresh from current DB state
 * and returns up to `scanLimit` rows — a plain, explicit scan cap, not a
 * persisted cross-tick cursor, because a row that succeeds simply stops
 * matching the `NOT EXISTS` clause on the next call.
 */
export async function findCompletedIssuesEligibleForAutomaticExtraction(
  db: Db,
  options: { scanLimit: number },
): Promise<EligibleCompletedIssue[]> {
  const sortKey = sql`coalesce(${issues.completedAt}, ${issues.updatedAt}, ${issues.createdAt})`;
  const rows = await db
    .select({ issueId: issues.id, companyId: issues.companyId })
    .from(issues)
    .innerJoin(
      issueDocuments,
      and(
        eq(issueDocuments.issueId, issues.id),
        eq(issueDocuments.companyId, issues.companyId),
        eq(issueDocuments.key, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY),
      ),
    )
    .innerJoin(
      documents,
      and(
        eq(documents.id, issueDocuments.documentId),
        eq(documents.companyId, issues.companyId),
      ),
    )
    .innerJoin(
      documentRevisions,
      and(
        eq(documentRevisions.id, documents.latestRevisionId),
        eq(documentRevisions.documentId, documents.id),
        eq(documentRevisions.companyId, issues.companyId),
      ),
    )
    .where(
      and(
        eq(issues.status, "done"),
        // Must match `revision.body?.trim()` in the extraction service
        // exactly (see `extractMemoryOperationCandidateFromCompletedIssue`'s
        // `empty_document` check): plain SQL `trim()` only strips spaces, not
        // newlines/tabs, so a whitespace-only body containing those would
        // otherwise pass this filter, never get created (the service's own
        // check still catches it), and — because no memory_operation ever
        // gets created for it — sit eligible forever, reattempted on every
        // single tick with no failure ever recorded and thus no cooldown.
        // `\S` (POSIX "non-whitespace") is the direct equivalent of JS's
        // whitespace-stripping `.trim()`.
        sql`${documentRevisions.body} ~ '\\S'`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(memoryOperations)
            .where(
              and(
                eq(memoryOperations.companyId, issues.companyId),
                eq(memoryOperations.sourceIssueId, issues.id),
                eq(memoryOperations.sourceType, "document"),
                sql`${memoryOperations.metadata}->>'extractionReason' = ${AUTOMATIC_EXTRACTION_REASON}`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(sortKey), asc(issues.id))
    .limit(options.scanLimit);
  return rows;
}

export interface ReconcileAutomaticMemoryOperationCandidatesResult {
  /** Rows returned by the eligibility scan (bounded by scanLimit), before cooldown filtering. */
  scanned: number;
  /** Extraction attempts actually made this tick — capped at batchSize, cooldown-skipped rows don't count. */
  attempted: number;
  created: number;
  deduplicated: number;
  skippedCooldown: number;
  failed: number;
}

export interface ReconcileAutomaticMemoryOperationCandidatesOptions {
  /** Maximum number of extraction *attempts* this tick — not successes. */
  batchSize: number;
  /**
   * How many eligible rows to fetch before applying the batch cap. Must
   * exceed `batchSize` so that Issues stuck in cooldown near the front of
   * the deterministic order don't crowd out healthy Issues behind them
   * within the same tick (starvation defense). Defaults to
   * `min(batchSize * 5, 500)`.
   */
  scanLimit?: number;
  cooldown?: FailureCooldownTracker;
  log?: Pick<typeof logger, "warn">;
}

/**
 * One bounded reconciliation pass. Safe to call repeatedly and
 * concurrently: failures never throw out of this function (each Issue is
 * isolated in its own try/catch), and the underlying insert's
 * `extractionKey` uniqueness makes concurrent/duplicate work harmless (see
 * `extractMemoryOperationCandidateFromCompletedIssue`). Scheduling
 * (single-flight, interval, startup-once) is the caller's job — see
 * `memory-candidate-reconciler-scheduler.ts` — this function itself has no
 * timers and no process-lifetime state beyond the optional injected
 * `cooldown` tracker.
 */
export async function reconcileAutomaticMemoryOperationCandidates(
  db: Db,
  options: ReconcileAutomaticMemoryOperationCandidatesOptions,
): Promise<ReconcileAutomaticMemoryOperationCandidatesResult> {
  const scanLimit = Math.min(
    MAX_SCAN_LIMIT,
    options.scanLimit ?? options.batchSize * DEFAULT_SCAN_LIMIT_MULTIPLIER,
  );
  const cooldown = options.cooldown ?? createFailureCooldownTracker();
  const log = options.log ?? logger;

  const candidates = await findCompletedIssuesEligibleForAutomaticExtraction(db, { scanLimit });

  const result: ReconcileAutomaticMemoryOperationCandidatesResult = {
    scanned: candidates.length,
    attempted: 0,
    created: 0,
    deduplicated: 0,
    skippedCooldown: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    if (result.attempted >= options.batchSize) break;
    if (cooldown.isInCooldown(candidate.issueId)) {
      result.skippedCooldown += 1;
      continue;
    }
    result.attempted += 1;
    try {
      const outcome = await extractMemoryOperationCandidateFromCompletedIssue(
        db,
        candidate.companyId,
        candidate.issueId,
        SYSTEM_ACTOR,
      );
      if (outcome.outcome === "created") result.created += 1;
      else if (outcome.outcome === "deduplicated") result.deduplicated += 1;
      // "skipped" outcomes here would mean the Issue stopped being eligible
      // between the scan and the attempt (e.g. reopened) — not a failure,
      // nothing to count as an error or cool down.
      cooldown.recordSuccess(candidate.issueId);
    } catch (error) {
      result.failed += 1;
      const { shouldLog, failureCount } = cooldown.recordFailure(candidate.issueId);
      if (shouldLog) {
        log.warn(
          { err: error, issueId: candidate.issueId, companyId: candidate.companyId, failureCount },
          "automatic memory operation candidate extraction failed; will retry after cooldown",
        );
      }
    }
  }

  return result;
}
