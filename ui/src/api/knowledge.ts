import { api } from "./client";
import type {
  MemorySourceType,
  MemoryOperationStatus,
  MemoryReviewState,
  KnowledgeRecordStatus,
  KnowledgeSyncState,
} from "@paperclipai/shared";

export type {
  MemorySourceType,
  MemoryOperationStatus,
  MemoryReviewState,
  KnowledgeRecordStatus,
  KnowledgeSyncState,
};

export interface MemoryOperationItem {
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
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRecordItem {
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
  obsidianSyncState: KnowledgeSyncState;
  obsidianSyncError: string | null;
  obsidianSyncedAt: string | null;
  externalBackendId: string | null;
  externalSyncState: KnowledgeSyncState | null;
  externalSyncError: string | null;
  externalSyncedAt: string | null;
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ReviewMemoryOperationParams {
  reviewState: "approved" | "rejected";
  reviewNotes?: string | null;
}

export interface PromoteMemoryOperationParams {
  knowledgeType?: string | null;
  title?: string;
  summary?: string | null;
  body?: string;
  metadata?: Record<string, unknown>;
}

export interface PromoteMemoryOperationResult {
  operation: MemoryOperationItem;
  knowledgeRecord: KnowledgeRecordItem;
  alreadyPromoted?: boolean;
}

export interface ListKnowledgeRecordsParams {
  q?: string;
  limit?: number;
}

export const knowledgeApi = {
  // Memory Operations
  listMemoryOperations: (companyId: string): Promise<MemoryOperationItem[]> =>
    api.get<MemoryOperationItem[]>(`/companies/${companyId}/memory-operations`),

  getMemoryOperation: (id: string): Promise<MemoryOperationItem> =>
    api.get<MemoryOperationItem>(`/memory-operations/${id}`),

  reviewMemoryOperation: (id: string, params: ReviewMemoryOperationParams): Promise<MemoryOperationItem> =>
    api.post<MemoryOperationItem>(`/memory-operations/${id}/review`, params),

  promoteMemoryOperation: (id: string, params: PromoteMemoryOperationParams = {}): Promise<PromoteMemoryOperationResult> =>
    api.post<PromoteMemoryOperationResult>(`/memory-operations/${id}/promote`, params),

  // Knowledge Records
  listKnowledgeRecords: (companyId: string, params?: ListKnowledgeRecordsParams): Promise<KnowledgeRecordItem[]> => {
    const searchParams = new URLSearchParams();
    if (params?.q) searchParams.set("q", params.q);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const queryStr = searchParams.toString();
    const endpoint = `/companies/${companyId}/knowledge-records${queryStr ? `?${queryStr}` : ""}`;
    return api.get<KnowledgeRecordItem[]>(endpoint);
  },

  getKnowledgeRecord: (id: string): Promise<KnowledgeRecordItem> =>
    api.get<KnowledgeRecordItem>(`/knowledge-records/${id}`),

  syncKnowledgeRecord: (id: string): Promise<KnowledgeRecordItem> =>
    api.post<KnowledgeRecordItem>(`/knowledge-records/${id}/obsidian-sync`, {}),
};
