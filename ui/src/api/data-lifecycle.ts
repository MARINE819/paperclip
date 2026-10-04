import { api } from "./client";
import type { DataLifecycleClass, DataLifecycleRetentionMode } from "@paperclipai/shared";

export type { DataLifecycleClass, DataLifecycleRetentionMode };

export type DataLifecycleStatus = "mapped" | "unmapped" | "file_based";

export interface DataLifecycleTableMapping {
  table: string;
  ageColumn: "createdAt";
  archivedColumn?: "archivedAt";
  deletedColumn?: "deletedAt";
}

export interface DataLifecyclePolicy {
  id: string;
  dataClass: DataLifecycleClass;
  retentionMode: DataLifecycleRetentionMode;
  retentionDays: number | null;
  archiveAfterDays: number | null;
  hardDeleteAfterDays: number | null;
  legalHold: boolean;
  enabled: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface DataLifecycleClassificationSummary {
  dataClass: DataLifecycleClass;
  description: string;
  status: DataLifecycleStatus;
  tables: DataLifecycleTableMapping[];
  notes: string;
  policy: DataLifecyclePolicy | null;
}

export type DryRunReason =
  | "no_policy_configured"
  | "policy_disabled"
  | "legal_hold_active"
  | "retention_mode_retain"
  | "invalid_retention_days"
  | "unsupported_data_class"
  | "ok";

export interface DryRunResult {
  dataClass: DataLifecycleClass;
  source: string;
  action: "none" | DataLifecycleRetentionMode;
  candidateCount: number;
  oldestCandidate: string | null;
  newestCandidate: string | null;
  estimatedRows: number;
  reason: DryRunReason;
}

export interface DataLifecyclePoliciesResponse {
  policies: DataLifecyclePolicy[];
}

export interface DataLifecycleSummaryResponse {
  classifications: DataLifecycleClassificationSummary[];
}

export interface DataLifecycleDryRunResponse {
  result: DryRunResult;
}

export const dataLifecycleApi = {
  policies: () => api.get<DataLifecyclePoliciesResponse>("/data-lifecycle/policies"),
  summary: () => api.get<DataLifecycleSummaryResponse>("/data-lifecycle/summary"),
  dryRun: (dataClass: DataLifecycleClass) =>
    api.get<DataLifecycleDryRunResponse>(`/data-lifecycle/dry-run?dataClass=${encodeURIComponent(dataClass)}`),
};
