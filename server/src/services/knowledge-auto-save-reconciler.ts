import { asc, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { knowledgeRecords } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  createFailureCooldownTracker,
  type FailureCooldownTracker,
} from "./memory-candidate-failure-cooldown.js";
import { getActiveKnowledgeBackendId, getKnowledgeBackend } from "./knowledge-backend.js";
import { syncKnowledgeRecordToBackend } from "./knowledge.js";

/**
 * F-07 durable automatic Knowledge Record -> KnowledgeBackend save,
 * structurally mirroring Phase 3.0B's automatic Memory Operation candidate
 * reconciler (`memory-candidate-extraction.ts`): a bounded, re-derived
 * eligibility scan plus a process-local failure cooldown, never a persisted
 * retry-state column. Calls `syncKnowledgeRecordToBackend` (the F-08
 * generic entry point) — never `obsidian-sync.ts` directly, so a future
 * second backend needs no change here.
 *
 * Eligibility is deliberately narrow: only `externalSyncState = "pending"`
 * or `"failed"`. A record whose `externalSyncState` is still `NULL` (every
 * knowledgeRecords row that existed before F-07 shipped) is NEVER
 * automatically selected — see `promoteMemoryOperation` in `knowledge.ts`,
 * which is the only place that now sets `externalSyncState: "pending"` on a
 * newly human-approved promotion. No backfill of historical rows is
 * performed by this module or any other part of this batch; the existing
 * Board-only manual sync endpoint remains the only way to sync a historical
 * record.
 */

export const KNOWLEDGE_AUTO_SAVE_RECONCILER_SYSTEM_ACTOR_ID = "knowledge-auto-save-reconciler";

/** How much larger than `batchSize` the per-tick scan window is, by default — matches Phase 3.0B's starvation-defense split. */
const DEFAULT_SCAN_LIMIT_MULTIPLIER = 5;
const MAX_SCAN_LIMIT = 500;

export interface EligibleKnowledgeRecord {
  knowledgeRecordId: string;
  companyId: string;
}

/**
 * The durable, migration-free eligibility query. Ordering is deterministic
 * (`updatedAt` then `id`) so no OFFSET pagination or persisted cursor is
 * needed: a record that gets synced simply stops matching the WHERE clause
 * on the next call.
 */
export async function findKnowledgeRecordsEligibleForAutoSave(
  db: Db,
  options: { scanLimit: number },
): Promise<EligibleKnowledgeRecord[]> {
  const rows = await db
    .select({ knowledgeRecordId: knowledgeRecords.id, companyId: knowledgeRecords.companyId })
    .from(knowledgeRecords)
    .where(
      or(
        eq(knowledgeRecords.externalSyncState, "pending"),
        eq(knowledgeRecords.externalSyncState, "failed"),
      ),
    )
    .orderBy(asc(knowledgeRecords.updatedAt), asc(knowledgeRecords.id))
    .limit(options.scanLimit);
  return rows;
}

export interface ReconcileKnowledgeAutoSaveOptions {
  /** Maximum number of write *attempts* this tick — not successes. */
  batchSize: number;
  /** How many eligible rows to fetch before applying the batch cap. Defaults to min(batchSize * 5, 500). */
  scanLimit?: number;
  cooldown?: FailureCooldownTracker;
  log?: Pick<typeof logger, "warn">;
  /** Test/override seam — defaults to the real F-08 registry lookup. */
  knowledgeBackendId?: string;
}

export interface ReconcileKnowledgeAutoSaveResult {
  /** Rows returned by the eligibility scan (bounded by scanLimit), before cooldown filtering. */
  scanned: number;
  /** Write attempts actually made this tick — capped at batchSize, cooldown-skipped rows don't count. */
  attempted: number;
  synced: number;
  failed: number;
  skippedCooldown: number;
}

/**
 * One bounded reconciliation pass. Safe to call repeatedly and
 * concurrently: a failure for one record never throws out of this function
 * (each record is isolated in its own try/catch), and `syncKnowledgeRecordToBackend`'s
 * per-record keyed lock makes a concurrent manual Board sync for the same
 * record serialize with this pass rather than race it. Scheduling
 * (single-flight, interval, startup-once) is the caller's job — see
 * `knowledge-auto-save-scheduler.ts` — this function itself has no timers.
 */
export async function reconcileKnowledgeAutoSave(
  db: Db,
  options: ReconcileKnowledgeAutoSaveOptions,
): Promise<ReconcileKnowledgeAutoSaveResult> {
  const scanLimit = Math.min(
    MAX_SCAN_LIMIT,
    options.scanLimit ?? options.batchSize * DEFAULT_SCAN_LIMIT_MULTIPLIER,
  );
  const cooldown = options.cooldown ?? createFailureCooldownTracker();
  const log = options.log ?? logger;
  const backend = getKnowledgeBackend(options.knowledgeBackendId ?? getActiveKnowledgeBackendId());

  const candidates = await findKnowledgeRecordsEligibleForAutoSave(db, { scanLimit });

  const result: ReconcileKnowledgeAutoSaveResult = {
    scanned: candidates.length,
    attempted: 0,
    synced: 0,
    failed: 0,
    skippedCooldown: 0,
  };

  for (const candidate of candidates) {
    if (result.attempted >= options.batchSize) break;
    if (cooldown.isInCooldown(candidate.knowledgeRecordId)) {
      result.skippedCooldown += 1;
      continue;
    }
    result.attempted += 1;
    try {
      const { outcome } = await syncKnowledgeRecordToBackend(db, backend, candidate.companyId, candidate.knowledgeRecordId);
      if (outcome.state === "synced") {
        result.synced += 1;
        cooldown.recordSuccess(candidate.knowledgeRecordId);
      } else {
        result.failed += 1;
        const { shouldLog, failureCount } = cooldown.recordFailure(candidate.knowledgeRecordId);
        if (shouldLog) {
          log.warn(
            { knowledgeRecordId: candidate.knowledgeRecordId, companyId: candidate.companyId, failureCount, error: outcome.error },
            "automatic knowledge backend save failed; will retry after cooldown",
          );
        }
      }
    } catch (error) {
      result.failed += 1;
      const { shouldLog, failureCount } = cooldown.recordFailure(candidate.knowledgeRecordId);
      if (shouldLog) {
        log.warn(
          { err: error, knowledgeRecordId: candidate.knowledgeRecordId, companyId: candidate.companyId, failureCount },
          "automatic knowledge backend save threw; will retry after cooldown",
        );
      }
    }
  }

  return result;
}
