// F-01 Data Lifecycle / Data Governance — pure classification mapping. Maps
// each recognized data class to the EXISTING table(s) that hold it (never
// invents a table, never forces a mapping that doesn't cleanly exist).
// See docs/investigations/nexora-f01-data-lifecycle-report.md for the
// Phase 0 audit this mapping is based on.

import type { DataLifecycleClass } from "@paperclipai/shared";

export type DataLifecycleTableMapping = {
  /** The service-layer table export name, e.g. "activityLog" — used to look up the Drizzle table at query time. */
  table: string;
  /** Column always present, used as the age basis for candidacy when no dedicated archive/delete column exists. */
  ageColumn: "createdAt";
  /** Existing archive-state column on this table, if any (never added by this batch). */
  archivedColumn?: "archivedAt";
  /** Existing soft-delete column on this table, if any. */
  deletedColumn?: "deletedAt";
};

export type DataLifecycleClassMapping = {
  dataClass: DataLifecycleClass;
  description: string;
  /** "mapped" = a real existing table this batch can dry-run against. "unmapped" = genuinely no clean existing table, reported honestly rather than forced. "file_based" = not a DB table at all (backup_metadata). */
  status: "mapped" | "unmapped" | "file_based";
  tables: DataLifecycleTableMapping[];
  notes: string;
};

export const DATA_LIFECYCLE_CLASSIFICATION: Record<DataLifecycleClass, DataLifecycleClassMapping> = {
  audit: {
    dataClass: "audit",
    description: "General company activity/audit trail",
    status: "mapped",
    tables: [{ table: "activityLog", ageColumn: "createdAt" }],
    notes: "Append-only by design — no archivedAt/deletedAt column exists on activity_log today. Candidacy is age-based (createdAt) only.",
  },
  runtime: {
    dataClass: "runtime",
    description: "Agent heartbeat run execution records",
    status: "mapped",
    tables: [{ table: "heartbeatRuns", ageColumn: "createdAt" }],
    notes: "Age-based (createdAt) only — heartbeat_runs has no archivedAt/deletedAt column.",
  },
  task: {
    dataClass: "task",
    description: "Work items (issues)",
    status: "mapped",
    tables: [{ table: "issues", ageColumn: "createdAt" }],
    notes: "Age-based (createdAt) only.",
  },
  approval: {
    dataClass: "approval",
    description: "Human approval decisions",
    status: "mapped",
    tables: [{ table: "approvals", ageColumn: "createdAt" }],
    notes: "Age-based (createdAt) only.",
  },
  incident: {
    dataClass: "incident",
    description: "F-06 runtime/Supervisor incidents",
    status: "mapped",
    tables: [{ table: "runtimeIncidents", ageColumn: "createdAt" }],
    notes: "runtime_incidents has resolvedAt but no archivedAt/deletedAt — age-based (createdAt) candidacy only. Resolved-vs-open state is not factored into candidacy this batch.",
  },
  eval: {
    dataClass: "eval",
    description: "F-04 agent eval runs",
    status: "mapped",
    tables: [{ table: "evalRuns", ageColumn: "createdAt" }],
    notes: "Age-based (createdAt) only — eval_runs has no archivedAt/deletedAt column.",
  },
  conversation: {
    dataClass: "conversation",
    description: "Issue thread interactions (chat-like activity)",
    status: "mapped",
    tables: [{ table: "issueThreadInteractions", ageColumn: "createdAt" }],
    notes: "Age-based (createdAt) only. This mapping is a reasonable best-fit, not a confirmed 1:1 'conversation' concept — flagged for review.",
  },
  memory_raw: {
    dataClass: "memory_raw",
    description: "Raw agent memory candidates",
    status: "mapped",
    tables: [{ table: "memoryOperations", ageColumn: "createdAt" }],
    notes: "memory_operations.status includes an 'archived' value but the table has NO archivedAt timestamp column (pre-existing gap, not introduced by this batch) — candidacy is age-based (createdAt) only.",
  },
  memory_summary: {
    dataClass: "memory_summary",
    description: "Summarized memory (distinct from raw candidates or verified knowledge)",
    status: "unmapped",
    tables: [],
    notes: "No existing table cleanly represents this as a distinct concept from memory_raw or verified_knowledge. Not force-mapped — dry-run reports 'unsupported data class' for this until a real table/column is identified.",
  },
  verified_knowledge: {
    dataClass: "verified_knowledge",
    description: "Promoted/verified knowledge records",
    status: "mapped",
    tables: [{ table: "knowledgeRecords", ageColumn: "createdAt", archivedColumn: "archivedAt" }],
    notes: "Already has a real archivedAt column and active/archived status — the most lifecycle-aware existing table this batch maps to.",
  },
  secret_audit: {
    dataClass: "secret_audit",
    description: "F-02 secret access audit events",
    status: "mapped",
    tables: [{ table: "secretAccessEvents", ageColumn: "createdAt" }],
    notes: "Append-only security evidence by design — no archivedAt/deletedAt column. Per Core Principle B, this class should generally receive longer retention than operational data, once a policy is configured.",
  },
  backup_metadata: {
    dataClass: "backup_metadata",
    description: "Database backup files on disk (not a DB table)",
    status: "file_based",
    tables: [],
    notes: "Governed today by the existing BackupRetentionPolicy {dailyDays, weeklyWeeks, monthlyMonths} in packages/db/src/backup-lib.ts (pruneOldBackups), which deletes immediately with no separate dry-run step. This batch's dry-run performs a PARALLEL, read-only mtime inspection using the same cutoff math — it never calls pruneOldBackups and never deletes.",
  },
};

export function classifyDataLifecycle(dataClass: DataLifecycleClass): DataLifecycleClassMapping {
  return DATA_LIFECYCLE_CLASSIFICATION[dataClass];
}

export function listDataLifecycleClassifications(): DataLifecycleClassMapping[] {
  return Object.values(DATA_LIFECYCLE_CLASSIFICATION);
}
