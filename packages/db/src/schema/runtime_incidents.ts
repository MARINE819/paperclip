import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Instance-level operational incidents (Supervisor/runtime/connectivity), not
// company-scoped — these describe the health of the NEXORA control plane
// itself, independent of any tenant. See server/src/services/incident-*.ts
// for the detectors that populate this table and
// docs/investigations/nexora-f06-incident-sre-minimum-system-report.md for
// the design.
export const runtimeIncidents = pgTable(
  "runtime_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fingerprint: text("fingerprint").notNull(),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    source: text("source").notNull(),
    instanceId: text("instance_id").notNull().default("default"),
    affectedComponents: jsonb("affected_components").$type<string[]>().notNull().default([]),
    observedState: jsonb("observed_state").$type<Record<string, unknown>>(),
    expectedState: jsonb("expected_state").$type<Record<string, unknown>>(),
    evidence: jsonb("evidence").$type<Record<string, unknown>[]>().notNull().default([]),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    relatedPid: text("related_pid"),
    relatedRunId: text("related_run_id"),
    recoveryAttempted: boolean("recovery_attempted").notNull().default(false),
    recoveryResult: text("recovery_result"),
    rootCause: text("root_cause"),
    rootCauseStatus: text("root_cause_status").notNull().default("unknown"),
    failureMemoryCandidate: boolean("failure_memory_candidate").notNull().default(false),
    failureMemoryDraft: jsonb("failure_memory_draft").$type<{
      problem: string;
      symptoms: string[];
      rootCause: string;
      failedAttempts: string[];
      verifiedRecovery: string;
      evidence: string[];
      recurrencePrevention: string;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Dedup key: only one non-resolved incident per (instance, fingerprint)
    // at a time. A fresh occurrence after resolution opens a new row rather
    // than reopening the resolved one, preserving resolved incidents as an
    // immutable historical record (mirrors budget_incidents' partial unique
    // index excluding its own terminal status).
    openFingerprintIdx: uniqueIndex("runtime_incidents_open_fingerprint_idx")
      .on(table.instanceId, table.fingerprint)
      .where(sql`${table.status} <> 'resolved'`),
    statusIdx: index("runtime_incidents_status_idx").on(table.instanceId, table.status),
    codeIdx: index("runtime_incidents_code_idx").on(table.instanceId, table.code),
    detectedAtIdx: index("runtime_incidents_detected_at_idx").on(table.instanceId, table.detectedAt),
  }),
);
