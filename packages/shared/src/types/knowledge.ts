export type MemorySourceType =
  | "work_product"
  | "issue"
  | "run"
  | "comment"
  | "document"
  | "decision"
  | "agent_output";

export type MemoryOperationStatus = "candidate" | "promoted" | "rejected" | "archived";

export type MemoryReviewState = "pending" | "approved" | "rejected";

export type KnowledgeRecordStatus = "active" | "archived";

export type ObsidianSyncState = "pending" | "synced" | "failed";

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
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}
