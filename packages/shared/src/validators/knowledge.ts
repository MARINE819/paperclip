import { z } from "zod";

export const memorySourceTypeSchema = z.enum([
  "work_product",
  "issue",
  "run",
  "comment",
  "document",
  "decision",
  "agent_output",
]);

export const memoryOperationStatusSchema = z.enum([
  "candidate",
  "promoted",
  "rejected",
  "archived",
]);

export const memoryReviewStateSchema = z.enum(["pending", "approved", "rejected"]);

export const knowledgeRecordStatusSchema = z.enum(["active", "archived"]);

export const obsidianSyncStateSchema = z.enum(["pending", "synced", "failed"]);

export const createMemoryOperationSchema = z.object({
  sourceType: memorySourceTypeSchema,
  sourceId: z.string().trim().min(1),
  sourceIssueId: z.string().guid().nullable().optional(),
  sourceRunId: z.string().guid().nullable().optional(),
  sourceAgentId: z.string().guid().nullable().optional(),
  title: z.string().trim().nullable().optional(),
  summary: z.string().trim().nullable().optional(),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extractionKey: z.string().trim().nullable().optional(),
});

export const updateMemoryOperationSchema = z.object({
  status: memoryOperationStatusSchema.optional(),
  reviewState: memoryReviewStateSchema.optional(),
  reviewedByAgentId: z.string().guid().nullable().optional(),
  reviewNotes: z.string().trim().nullable().optional(),
  approvalId: z.string().guid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const reviewMemoryOperationSchema = z.object({
  reviewState: z.enum(["approved", "rejected"]),
  reviewNotes: z.string().trim().nullable().optional(),
}).strict();

export const promoteMemoryOperationSchema = z.object({
  knowledgeType: z.string().trim().nullable().optional(),
  title: z.string().trim().min(1).optional(),
  summary: z.string().trim().nullable().optional(),
  body: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

// Deliberately accepts nothing: the vault root and the file path are always
// server-owned (see server/src/services/obsidian-vault-config.ts and
// obsidian-sync.ts). `.strict()` rejects any client attempt to smuggle a
// path-shaped field into the request body instead of silently ignoring it.
export const obsidianSyncRequestSchema = z.object({}).strict();

// Deliberately accepts nothing: the source Issue id comes only from the URL
// path, and the extraction itself is fully deterministic server-side logic
// (see server/src/services/memory-candidate-extraction.ts) — there is no
// client-supplied content or source selection to validate here.
export const extractMemoryOperationCandidateRequestSchema = z.object({}).strict();

export const createKnowledgeRecordSchema = z.object({
  knowledgeType: z.string().trim().nullable().optional(),
  title: z.string().trim().min(1),
  summary: z.string().trim().nullable().optional(),
  body: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sourceMemoryOperationId: z.string().guid().nullable().optional(),
  sourceIssueId: z.string().guid().nullable().optional(),
  sourceRunId: z.string().guid().nullable().optional(),
  sourceAgentId: z.string().guid().nullable().optional(),
  obsidianPath: z.string().trim().nullable().optional(),
});
