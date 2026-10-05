import { and, eq, ne } from "drizzle-orm";
import { runtimeIncidents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { IncidentCandidate, LifecycleEvent } from "./incident-detection.js";

const MAX_EVIDENCE_ENTRIES = 20;

export type RuntimeIncidentRow = typeof runtimeIncidents.$inferSelect;

export type ApplyScanResult = {
  opened: RuntimeIncidentRow[];
  updated: RuntimeIncidentRow[];
  resolved: RuntimeIncidentRow[];
};

async function findOpenByFingerprint(
  db: Db,
  instanceId: string,
  fingerprint: string,
): Promise<RuntimeIncidentRow | undefined> {
  const rows = await db
    .select()
    .from(runtimeIncidents)
    .where(
      and(
        eq(runtimeIncidents.instanceId, instanceId),
        eq(runtimeIncidents.fingerprint, fingerprint),
        ne(runtimeIncidents.status, "resolved"),
      ),
    )
    .limit(1);
  return rows[0];
}

async function findAllOpen(db: Db, instanceId: string): Promise<RuntimeIncidentRow[]> {
  return db
    .select()
    .from(runtimeIncidents)
    .where(and(eq(runtimeIncidents.instanceId, instanceId), ne(runtimeIncidents.status, "resolved")));
}

function hasRecentRecoveryAttempt(events: LifecycleEvent[], sinceMs: number): boolean {
  return events.some((e) => e.event === "recovery_attempt" && Number.isFinite(Date.parse(e.at)) && Date.parse(e.at) >= sinceMs);
}

function hasRecoverySucceeded(events: LifecycleEvent[], sinceMs: number): boolean {
  return events.some(
    (e) => (e.event === "recovery_succeeded" || e.event === "CONTROL_PLANE_RECOVERED") &&
      Number.isFinite(Date.parse(e.at)) && Date.parse(e.at) >= sinceMs,
  );
}

// Evidence-sufficiency for Failure Memory eligibility — deliberately
// conservative: a resolved incident is only a *candidate* (never
// auto-VERIFIED) when it has real evidence AND either an actual recovery
// was attempted or the condition was independently observed more than once
// (rules out one-off, possibly-transient blips).
function isFailureMemoryCandidate(incident: {
  evidence: unknown[];
  recoveryAttempted: boolean;
  occurrenceCount: number;
}): boolean {
  return incident.evidence.length > 0 && (incident.recoveryAttempted || incident.occurrenceCount >= 2);
}

function buildFailureMemoryDraft(incident: RuntimeIncidentRow) {
  return {
    problem: `${incident.code} observed on instance ${incident.instanceId}`,
    symptoms: incident.evidence.map((e) => JSON.stringify(e)),
    rootCause: incident.rootCause ?? "UNKNOWN",
    failedAttempts: [] as string[],
    verifiedRecovery: incident.recoveryResult === "succeeded"
      ? "Condition cleared on a subsequent scan; see evidence."
      : "Condition no longer observed on a subsequent scan (recovery mechanism not independently confirmed).",
    evidence: incident.evidence.map((e) => JSON.stringify(e)),
    recurrencePrevention: "Not yet defined — candidate only, human review required before promotion.",
  };
}

/**
 * Applies one detection scan's candidates against stored state:
 *  - a candidate with no existing open row -> INSERT (status=open)
 *  - a candidate matching an existing open row (same fingerprint) -> UPDATE
 *    (lastObservedAt, evidence appended/capped, occurrenceCount++; status
 *    becomes "recovering" if a recovery_attempt fired after it was detected)
 *  - an existing open row whose fingerprint is NOT in this scan's candidates
 *    -> RESOLVED (condition cleared), with failureMemoryCandidate computed
 *
 * Pure with respect to the outside world except for the given `db` — safe to
 * run against an isolated test database with synthetic candidates/events.
 */
export async function applyIncidentScan(
  db: Db,
  instanceId: string,
  candidates: IncidentCandidate[],
  recentLifecycleEvents: LifecycleEvent[],
  now: Date,
): Promise<ApplyScanResult> {
  const opened: RuntimeIncidentRow[] = [];
  const updated: RuntimeIncidentRow[] = [];
  const resolved: RuntimeIncidentRow[] = [];
  const seenFingerprints = new Set<string>();

  for (const candidate of candidates) {
    seenFingerprints.add(candidate.fingerprint);
    const existing = await findOpenByFingerprint(db, instanceId, candidate.fingerprint);
    if (!existing) {
      const [row] = await db
        .insert(runtimeIncidents)
        .values({
          fingerprint: candidate.fingerprint,
          code: candidate.code,
          severity: candidate.severity,
          status: "open",
          detectedAt: now,
          lastObservedAt: now,
          source: candidate.source,
          instanceId,
          affectedComponents: candidate.affectedComponents,
          observedState: candidate.observedState,
          expectedState: candidate.expectedState,
          evidence: candidate.evidence.slice(-MAX_EVIDENCE_ENTRIES),
          occurrenceCount: 1,
          relatedPid: candidate.relatedPid ?? null,
          relatedRunId: candidate.relatedRunId ?? null,
          recoveryAttempted: candidate.recoveryAttempted,
          recoveryResult: candidate.recoveryResult ?? null,
          rootCause: candidate.rootCause ?? null,
          rootCauseStatus: candidate.rootCauseStatus,
          updatedAt: now,
        })
        .returning();
      opened.push(row);
      continue;
    }

    // Dedupe by exact evidence content, not just append: a discrete past
    // event (e.g. detector F's runtime_exit, detector B's recovery_cycle_
    // scheduled) is re-derived identically from the same immutable log line
    // on every scan for as long as it remains within the tailed read
    // window, and must not re-count as a "new occurrence" each cycle —
    // that previously inflated occurrenceCount and duplicated evidence for
    // a single historical event (confirmed live: a single 0xC000013A exit
    // showed occurrenceCount=3 with 3 identical evidence entries after 3
    // scan cycles). A detector whose evidence genuinely changes each scan
    // (e.g. detector D's connectivity check, which stamps the latest
    // probe's own fresh timestamp) still counts correctly, since its
    // content is never byte-identical to the previous scan's.
    const existingEvidenceKeys = new Set(existing.evidence.map((e) => JSON.stringify(e)));
    const newEvidenceEntries = candidate.evidence.filter((e) => !existingEvidenceKeys.has(JSON.stringify(e)));
    const mergedEvidence = [...existing.evidence, ...newEvidenceEntries].slice(-MAX_EVIDENCE_ENTRIES);
    const recovering = hasRecentRecoveryAttempt(recentLifecycleEvents, existing.detectedAt.getTime());
    const [row] = await db
      .update(runtimeIncidents)
      .set({
        status: recovering ? "recovering" : existing.status,
        lastObservedAt: now,
        evidence: mergedEvidence,
        occurrenceCount: existing.occurrenceCount + newEvidenceEntries.length,
        observedState: candidate.observedState,
        recoveryAttempted: existing.recoveryAttempted || candidate.recoveryAttempted,
        recoveryResult: candidate.recoveryResult ?? existing.recoveryResult,
        updatedAt: now,
      })
      .where(eq(runtimeIncidents.id, existing.id))
      .returning();
    updated.push(row);
  }

  const openRows = await findAllOpen(db, instanceId);
  for (const row of openRows) {
    if (seenFingerprints.has(row.fingerprint)) continue;
    const succeeded = hasRecoverySucceeded(recentLifecycleEvents, row.detectedAt.getTime());
    const recoveryResult = succeeded ? "succeeded" : (row.recoveryResult ?? "cleared");
    const candidateForMemory = {
      evidence: row.evidence,
      recoveryAttempted: row.recoveryAttempted,
      occurrenceCount: row.occurrenceCount,
    };
    const failureMemoryCandidate = isFailureMemoryCandidate(candidateForMemory);
    const [resolvedRow] = await db
      .update(runtimeIncidents)
      .set({
        status: "resolved",
        resolvedAt: now,
        recoveryResult,
        failureMemoryCandidate,
        updatedAt: now,
      })
      .where(eq(runtimeIncidents.id, row.id))
      .returning();
    const withDraft = failureMemoryCandidate
      ? (
        await db
          .update(runtimeIncidents)
          .set({ failureMemoryDraft: buildFailureMemoryDraft(resolvedRow) })
          .where(eq(runtimeIncidents.id, row.id))
          .returning()
      )[0]
      : resolvedRow;
    resolved.push(withDraft);
  }

  return { opened, updated, resolved };
}

export async function listOpenIncidents(db: Db, instanceId: string): Promise<RuntimeIncidentRow[]> {
  return db
    .select()
    .from(runtimeIncidents)
    .where(and(eq(runtimeIncidents.instanceId, instanceId), ne(runtimeIncidents.status, "resolved")));
}

export async function listResolvedIncidents(
  db: Db,
  instanceId: string,
  limit = 50,
): Promise<RuntimeIncidentRow[]> {
  return db
    .select()
    .from(runtimeIncidents)
    .where(and(eq(runtimeIncidents.instanceId, instanceId), eq(runtimeIncidents.status, "resolved")))
    .limit(limit);
}
