export type MemorySourceType =
  | "work_product"
  | "issue"
  | "run"
  | "comment"
  | "document"
  | "decision"
  | "agent_output"
  // JARVIS-01: a Board-triggered promotion of a resolved runtime incident's
  // failureMemoryDraft (F-06) into a reviewable candidate. sourceId is
  // always the runtime_incidents.id. See
  // server/src/services/failure-memory-promotion.ts — only minimum
  // provenance is ever copied here, never the raw draft.
  | "incident_failure_memory";

export type MemoryOperationStatus = "candidate" | "promoted" | "rejected" | "archived";

export type MemoryReviewState = "pending" | "approved" | "rejected";

export type KnowledgeRecordStatus = "active" | "archived";

// F-08 Pluggable Knowledge Backend — generic sync-state name. ObsidianSyncState
// is kept as a compatible alias (identical literal union) so existing imports
// never break; new code should prefer KnowledgeSyncState, which applies to
// any backend, not just Obsidian.
export type KnowledgeSyncState = "pending" | "synced" | "failed";

export type ObsidianSyncState = KnowledgeSyncState;

export interface MemoryOperation {
  id: string;
  companyId: string;
  sourceType: MemorySourceType;
  sourceId: string;
  sourceIssueId: string | null;
  sourceRunId: string | null;
  sourceAgentId: string | null;
  title: string | null;
  summary: string | null;
  content: string;
  confidence: number | null;
  status: MemoryOperationStatus;
  reviewState: MemoryReviewState;
  reviewedByAgentId: string | null;
  reviewNotes: string | null;
  approvalId: string | null;
  extractionKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeRecord {
  id: string;
  companyId: string;
  knowledgeType: string | null;
  title: string;
  summary: string | null;
  body: string;
  metadata: Record<string, unknown>;
  sourceMemoryOperationId: string | null;
  sourceIssueId: string | null;
  sourceRunId: string | null;
  sourceAgentId: string | null;
  status: KnowledgeRecordStatus;
  obsidianPath: string | null;
  obsidianSyncState: ObsidianSyncState;
  obsidianSyncError: string | null;
  obsidianSyncedAt: Date | null;
  // F-08 Pluggable Knowledge Backend — generic counterparts of the obsidian*
  // columns above. Written alongside them during this compatibility phase;
  // see docs/contracts/nexora-f08-knowledge-backend-architecture.md.
  externalBackendId: string | null;
  externalSyncState: KnowledgeSyncState | null;
  externalSyncError: string | null;
  externalSyncedAt: Date | null;
  externalRef: string | null;
  // M2-03-B01 Knowledge Revision & Confidence Hardening — additive only.
  confidence: number | null;
  latestRevisionId: string | null;
  revisionNumber: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

// M2-03-B01 — one append-only row per promotion/update of a KnowledgeRecord.
// Mirrors the existing, already-proven DocumentRevision shape.
export interface KnowledgeRecordRevision {
  id: string;
  companyId: string;
  knowledgeRecordId: string;
  revisionNumber: number;
  knowledgeType: string | null;
  title: string;
  summary: string | null;
  body: string;
  confidence: number | null;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  createdAt: Date;
}
