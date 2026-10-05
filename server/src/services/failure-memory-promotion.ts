import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, memoryOperations, runtimeIncidents } from "@paperclipai/db";
import { isUniqueViolation } from "../db-errors.js";
import { persistActivity, publishActivity, type LogActivityInput } from "./activity-log.js";

/**
 * JARVIS-01 — Failure Memory -> Verified Knowledge closure loop.
 *
 * Connects two already-complete, already-verified systems without
 * modifying either: F-06's incident-store.ts already computes
 * `failureMemoryCandidate`/`failureMemoryDraft` on resolved incidents
 * (never read elsewhere until now); F-01/F-07/F-08's
 * memoryOperations -> review -> approve -> promote -> knowledgeRecords ->
 * auto-save pipeline already exists, fully tested, unmodified by this file.
 *
 * Tenant data safety (see docs/investigations/jarvis-01-failure-memory-closure-loop-report.md
 * for the full evidence trail): `runtime_incidents` is instance-scoped and
 * its `failureMemoryDraft` carries raw control-plane evidence (PIDs, ports,
 * Supervisor lifecycle log fragments). `memoryOperations` candidates are
 * readable by ordinary company board members (including viewer role) and
 * by agents in that company — BEFORE any review. This module therefore
 * NEVER copies the raw draft into a candidate: only a minimum provenance
 * allowlist (incidentId/incidentCode/incidentSeverity/detectedAt/resolvedAt)
 * is stored, and `content` is a safe pointer directing a Board reviewer to
 * the existing instance-admin-only incident view for full evidence.
 *
 * Idempotency is GLOBAL, not per-company: a resolved incident is instance-
 * scoped (it has no company of its own), so at most one candidate may ever
 * exist for it, across every company — enforced by a DB-level partial
 * unique index on (sourceType, sourceId) that deliberately excludes
 * companyId (packages/db/src/schema/memory_operations.ts). Promoting the
 * same incident into two different companies both deduplicate against
 * whichever one committed first.
 */

export const FAILURE_MEMORY_SOURCE_TYPE = "incident_failure_memory" as const;
const GLOBAL_UNIQUE_CONSTRAINT = "memory_operations_incident_failure_memory_global_uq";

export type FailureMemoryPromotionActor = Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId">;

export type FailureMemoryPromotionOutcome =
  | { outcome: "created"; operation: typeof memoryOperations.$inferSelect }
  | { outcome: "deduplicated"; operation: typeof memoryOperations.$inferSelect }
  | {
    outcome: "skipped";
    reason:
      | "company_not_found"
      | "incident_not_found"
      | "incident_not_resolved"
      | "not_failure_memory_candidate"
      | "missing_failure_memory_draft";
  };

function renderSafeContentStub(incident: {
  id: string;
  code: string;
  severity: string;
  detectedAt: Date;
  resolvedAt: Date | null;
}): string {
  return [
    `Failure memory candidate for incident ${incident.code} (severity: ${incident.severity}).`,
    `Detected: ${incident.detectedAt.toISOString()}. Resolved: ${incident.resolvedAt?.toISOString() ?? "unknown"}.`,
    "",
    `Full incident evidence and root-cause detail (instance-admin only) is available via` +
      ` GET /api/instance/incidents (incident id: ${incident.id}).`,
    "",
    "Raw evidence is intentionally not duplicated here to avoid exposing control-plane" +
      " internals to company-scoped knowledge storage — consult the full incident record" +
      " before approving this candidate.",
  ].join("\n");
}

/**
 * Promotes one resolved incident's failure-memory signal into a
 * memoryOperations candidate in the given company. Never throws for an
 * ineligible/not-found input — those return `{outcome:"skipped", reason}`.
 * Fails closed: every eligibility condition must hold before any row is
 * written.
 */
export async function promoteIncidentFailureMemoryToCandidate(
  db: Db,
  companyId: string,
  incidentId: string,
  actor: FailureMemoryPromotionActor,
): Promise<FailureMemoryPromotionOutcome> {
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return { outcome: "skipped", reason: "company_not_found" };

  const [incident] = await db.select().from(runtimeIncidents).where(eq(runtimeIncidents.id, incidentId)).limit(1);
  if (!incident) return { outcome: "skipped", reason: "incident_not_found" };
  if (incident.status !== "resolved") return { outcome: "skipped", reason: "incident_not_resolved" };
  if (!incident.failureMemoryCandidate) return { outcome: "skipped", reason: "not_failure_memory_candidate" };
  if (!incident.failureMemoryDraft) return { outcome: "skipped", reason: "missing_failure_memory_draft" };

  const values = {
    companyId,
    sourceType: FAILURE_MEMORY_SOURCE_TYPE,
    sourceId: incident.id,
    title: `Failure Memory: ${incident.code}`,
    summary: null,
    content: renderSafeContentStub(incident),
    // Minimum provenance allowlist only — never the raw draft (symptoms,
    // evidence, rootCause, failedAttempts, verifiedRecovery,
    // recurrencePrevention, instanceId are all deliberately excluded).
    metadata: {
      incidentId: incident.id,
      incidentCode: incident.code,
      incidentSeverity: incident.severity,
      detectedAt: incident.detectedAt.toISOString(),
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      sourceType: FAILURE_MEMORY_SOURCE_TYPE,
      createdFromFailureMemory: true,
    },
  };

  try {
    const { operation, publication } = await db.transaction(async (tx) => {
      const [created] = await tx.insert(memoryOperations).values(values).returning();
      const { publication: pub } = await persistActivity(tx as unknown as Db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory_operation.failure_memory_promoted",
        entityType: "memory_operation",
        entityId: created!.id,
        details: {
          sourceType: created!.sourceType,
          sourceId: created!.sourceId,
          incidentCode: incident.code,
        },
      });
      return { operation: created!, publication: pub };
    });
    publishActivity(publication);
    return { outcome: "created", operation };
  } catch (error) {
    if (isUniqueViolation(error, GLOBAL_UNIQUE_CONSTRAINT)) {
      // Global dedup: the existing candidate may belong to a DIFFERENT
      // company than the one just attempted (that's the whole point of the
      // global-not-per-company index) — look up by sourceType+sourceId
      // alone, never scoped by companyId.
      const [existing] = await db
        .select()
        .from(memoryOperations)
        .where(and(eq(memoryOperations.sourceType, FAILURE_MEMORY_SOURCE_TYPE), eq(memoryOperations.sourceId, incident.id)))
        .limit(1);
      if (existing) return { outcome: "deduplicated", operation: existing };
    }
    throw error;
  }
}

