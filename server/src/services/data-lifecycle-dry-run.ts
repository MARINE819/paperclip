import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { count, eq, lt, max, min } from "drizzle-orm";
import {
  activityLog,
  approvals,
  dataLifecyclePolicies,
  evalRuns,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  knowledgeRecords,
  memoryOperations,
  runtimeIncidents,
  secretAccessEvents,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { DataLifecycleClass, DataLifecycleRetentionMode } from "@paperclipai/shared";
import { classifyDataLifecycle } from "./data-lifecycle-classification.js";

// F-01 Data Lifecycle / Data Governance — READ-ONLY dry-run candidate
// calculation. Every code path in this file is a SELECT (or, for
// backup_metadata, a filesystem stat) — nothing here ever mutates a row or
// deletes a file. Fail-closed on: no policy, disabled policy, legal hold,
// invalid/missing retention days for the configured mode, and unsupported
// data classes (never guesses a substitute).

export type DryRunReason =
  | "no_policy_configured"
  | "policy_disabled"
  | "legal_hold_active"
  | "retention_mode_retain"
  | "invalid_retention_days"
  | "unsupported_data_class"
  | "ok";

export type DryRunResult = {
  dataClass: DataLifecycleClass;
  source: string;
  action: "none" | DataLifecycleRetentionMode;
  candidateCount: number;
  oldestCandidate: string | null;
  newestCandidate: string | null;
  estimatedRows: number;
  reason: DryRunReason;
};

function blocked(dataClass: DataLifecycleClass, source: string, reason: DryRunReason): DryRunResult {
  return {
    dataClass,
    source,
    action: "none",
    candidateCount: 0,
    oldestCandidate: null,
    newestCandidate: null,
    estimatedRows: 0,
    reason,
  };
}

// Direct, statically-typed table reference per mapped class — deliberately
// not a dynamic string-keyed lookup, so every query below is fully typed.
const CREATED_AT_TABLES = {
  audit: activityLog,
  runtime: heartbeatRuns,
  task: issues,
  approval: approvals,
  incident: runtimeIncidents,
  eval: evalRuns,
  conversation: issueThreadInteractions,
  memory_raw: memoryOperations,
  verified_knowledge: knowledgeRecords,
  secret_audit: secretAccessEvents,
} as const;

type CreatedAtClass = keyof typeof CREATED_AT_TABLES;

function isCreatedAtClass(dataClass: DataLifecycleClass): dataClass is CreatedAtClass {
  return dataClass in CREATED_AT_TABLES;
}

function daysForMode(
  mode: DataLifecycleRetentionMode,
  policy: { retentionDays: number | null; archiveAfterDays: number | null; hardDeleteAfterDays: number | null },
): number | null {
  switch (mode) {
    case "retain":
      return null;
    case "archive":
    case "delete":
      return policy.retentionDays;
    case "archive_then_delete":
      // The archive stage happens first chronologically — reported as the
      // primary dry-run action. hardDeleteAfterDays governs a later stage
      // not computed in this minimum-system dry-run.
      return policy.archiveAfterDays;
  }
}

function isValidDays(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function computeCreatedAtClassDryRun(
  db: Db,
  dataClass: CreatedAtClass,
  source: string,
  now: Date,
): Promise<DryRunResult> {
  const [policyRow] = await db
    .select()
    .from(dataLifecyclePolicies)
    .where(eq(dataLifecyclePolicies.dataClass, dataClass))
    .limit(1);

  if (!policyRow) return blocked(dataClass, source, "no_policy_configured");
  if (!policyRow.enabled) return blocked(dataClass, source, "policy_disabled");
  if (policyRow.legalHold) return blocked(dataClass, source, "legal_hold_active");
  if (policyRow.retentionMode === "retain") return blocked(dataClass, source, "retention_mode_retain");

  const days = daysForMode(policyRow.retentionMode, policyRow);
  if (!isValidDays(days)) return blocked(dataClass, source, "invalid_retention_days");

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const table = CREATED_AT_TABLES[dataClass];
  const [row] = await db
    .select({
      candidateCount: count(),
      oldest: min(table.createdAt),
      newest: max(table.createdAt),
    })
    .from(table)
    .where(lt(table.createdAt, cutoff));

  return {
    dataClass,
    source,
    action: policyRow.retentionMode,
    candidateCount: row?.candidateCount ?? 0,
    oldestCandidate: row?.oldest ? new Date(row.oldest as unknown as string).toISOString() : null,
    newestCandidate: row?.newest ? new Date(row.newest as unknown as string).toISOString() : null,
    estimatedRows: row?.candidateCount ?? 0,
    reason: "ok",
  };
}

/**
 * Read-only filesystem inspection mirroring
 * packages/db/src/backup-lib.ts's BackupRetentionPolicy cutoff math —
 * never calls pruneOldBackups, never deletes. `backupDir` must be passed
 * explicitly by the caller (never inferred here) so this stays testable
 * against an isolated temp directory.
 */
async function computeBackupMetadataDryRun(
  db: Db,
  backupDir: string | null,
  now: Date,
): Promise<DryRunResult> {
  const [policyRow] = await db
    .select()
    .from(dataLifecyclePolicies)
    .where(eq(dataLifecyclePolicies.dataClass, "backup_metadata"))
    .limit(1);

  if (!policyRow) return blocked("backup_metadata", "filesystem", "no_policy_configured");
  if (!policyRow.enabled) return blocked("backup_metadata", "filesystem", "policy_disabled");
  if (policyRow.legalHold) return blocked("backup_metadata", "filesystem", "legal_hold_active");
  if (policyRow.retentionMode === "retain") return blocked("backup_metadata", "filesystem", "retention_mode_retain");

  const days = daysForMode(policyRow.retentionMode, policyRow);
  if (!isValidDays(days)) return blocked("backup_metadata", "filesystem", "invalid_retention_days");
  if (!backupDir || !existsSync(backupDir)) return blocked("backup_metadata", "filesystem", "invalid_retention_days");

  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const files = readdirSync(backupDir).filter((name) => name.endsWith(".sql.gz") || name.endsWith(".sql"));
  let oldestMs: number | null = null;
  let newestMs: number | null = null;
  let candidateCount = 0;
  for (const name of files) {
    const stat = statSync(path.join(backupDir, name));
    if (stat.mtimeMs >= cutoffMs) continue;
    candidateCount += 1;
    if (oldestMs === null || stat.mtimeMs < oldestMs) oldestMs = stat.mtimeMs;
    if (newestMs === null || stat.mtimeMs > newestMs) newestMs = stat.mtimeMs;
  }

  return {
    dataClass: "backup_metadata",
    source: "filesystem",
    action: policyRow.retentionMode,
    candidateCount,
    oldestCandidate: oldestMs !== null ? new Date(oldestMs).toISOString() : null,
    newestCandidate: newestMs !== null ? new Date(newestMs).toISOString() : null,
    estimatedRows: candidateCount,
    reason: "ok",
  };
}

export type DryRunOptions = {
  now?: Date;
  /** Only consulted for dataClass="backup_metadata" — never inferred/defaulted to a real production path here. */
  backupDir?: string;
};

export async function computeDryRun(
  db: Db,
  dataClass: DataLifecycleClass,
  options: DryRunOptions = {},
): Promise<DryRunResult> {
  const now = options.now ?? new Date();
  const classification = classifyDataLifecycle(dataClass);

  if (classification.status === "unmapped") {
    return blocked(dataClass, "none", "unsupported_data_class");
  }
  if (classification.status === "file_based") {
    return computeBackupMetadataDryRun(db, options.backupDir ?? null, now);
  }
  if (!isCreatedAtClass(dataClass)) {
    // Defensive — every "mapped" classification today is a CreatedAtClass;
    // this only triggers if classification.ts and this file's table map
    // ever drift apart, and fails closed rather than guessing.
    return blocked(dataClass, "none", "unsupported_data_class");
  }
  return computeCreatedAtClassDryRun(db, dataClass, classification.tables[0]?.table ?? dataClass, now);
}
