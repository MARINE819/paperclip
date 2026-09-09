import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  heartbeatRuns,
  issues,
  knowledgeRecords,
  memoryOperations,
} from "@paperclipai/db";
import type { MemorySourceType } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { resolveObsidianVaultRoot } from "./obsidian-vault-config.js";
import { syncKnowledgeRecordToObsidian, type ObsidianSyncOutcome } from "./obsidian-sync.js";
import { knowledgeRecordLockKey, withKnowledgeRecordLock } from "./knowledge-record-lock.js";

type ObsidianSyncFn = (
  vaultRoot: string | null,
  record: Parameters<typeof syncKnowledgeRecordToObsidian>[1],
) => Promise<ObsidianSyncOutcome>;

type CreateMemoryOperationInput = {
  companyId: string;
  sourceType: MemorySourceType;
  sourceId: string;
  sourceIssueId?: string | null;
  sourceRunId?: string | null;
  sourceAgentId?: string | null;
  title?: string | null;
  summary?: string | null;
  content: string;
  confidence?: number | null;
  extractionKey?: string | null;
  metadata?: Record<string, unknown>;
};

type PromoteMemoryOperationInput = {
  knowledgeType?: string | null;
  title?: string;
  summary?: string | null;
  body?: string;
  metadata?: Record<string, unknown>;
};

export async function assertOptionalCompanyReference(
  dbOrTx: any,
  table: any,
  id: string | null | undefined,
  companyId: string,
  label: string,
) {
  if (!id) return;
  const row = await dbOrTx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.companyId, companyId)))
    .limit(1)
    .then((rows: Array<{ id: string }>) => rows[0]);
  if (!row) throw unprocessable(`${label} must belong to the same company`);
}

export function buildKnowledgeProvenanceSnapshot(operation: typeof memoryOperations.$inferSelect) {
  return {
    sourceType: operation.sourceType,
    sourceId: operation.sourceId,
    sourceIssueId: operation.sourceIssueId,
    sourceRunId: operation.sourceRunId,
    sourceAgentId: operation.sourceAgentId,
    memoryOperationId: operation.id,
    capturedAt: new Date().toISOString(),
  };
}

export type KnowledgeServiceOptions = {
  obsidianVaultRoot?: string | null;
  /** Test-only seam: overrides the actual filesystem sync implementation. */
  obsidianSyncFn?: ObsidianSyncFn;
};

export function knowledgeService(db: Db, options: KnowledgeServiceOptions = {}) {
  const vaultRoot = options.obsidianVaultRoot !== undefined
    ? options.obsidianVaultRoot
    : resolveObsidianVaultRoot();
  const runObsidianSync: ObsidianSyncFn = options.obsidianSyncFn ?? syncKnowledgeRecordToObsidian;
  return {
    createMemoryOperation: async (input: CreateMemoryOperationInput) => {
      await Promise.all([
        assertOptionalCompanyReference(db, issues, input.sourceIssueId, input.companyId, "sourceIssueId"),
        assertOptionalCompanyReference(db, heartbeatRuns, input.sourceRunId, input.companyId, "sourceRunId"),
        assertOptionalCompanyReference(db, agents, input.sourceAgentId, input.companyId, "sourceAgentId"),
      ]);
      const [created] = await db.insert(memoryOperations).values({
        ...input,
        metadata: input.metadata ?? {},
      }).returning();
      return created!;
    },

    listMemoryOperations: (companyId: string) => db
      .select()
      .from(memoryOperations)
      .where(eq(memoryOperations.companyId, companyId))
      .orderBy(desc(memoryOperations.createdAt), desc(memoryOperations.id)),

    getMemoryOperation: (id: string) => db
      .select()
      .from(memoryOperations)
      .where(eq(memoryOperations.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null),

    reviewMemoryOperation: async (
      id: string,
      input: { reviewState: "approved" | "rejected"; reviewNotes?: string | null; reviewedByAgentId?: string | null },
    ) => {
      const existing = await db.select().from(memoryOperations).where(eq(memoryOperations.id, id)).limit(1)
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Memory operation not found");
      if (existing.status !== "candidate") throw conflict("Only candidate memory operations can be reviewed");
      await assertOptionalCompanyReference(
        db,
        agents,
        input.reviewedByAgentId,
        existing.companyId,
        "reviewedByAgentId",
      );
      const [updated] = await db.update(memoryOperations).set({
        reviewState: input.reviewState,
        reviewNotes: input.reviewNotes,
        reviewedByAgentId: input.reviewedByAgentId ?? null,
        status: input.reviewState === "rejected" ? "rejected" : "candidate",
        updatedAt: new Date(),
      }).where(and(eq(memoryOperations.id, id), eq(memoryOperations.status, "candidate"))).returning();
      if (!updated) throw conflict("Memory operation changed while it was being reviewed");
      return updated;
    },

    promoteMemoryOperation: async (id: string, input: PromoteMemoryOperationInput) => db.transaction(async (tx) => {
      await tx.execute(sql`select ${memoryOperations.id} from ${memoryOperations} where ${memoryOperations.id} = ${id} for update`);
      const operation = await tx.select().from(memoryOperations).where(eq(memoryOperations.id, id)).limit(1)
        .then((rows) => rows[0] ?? null);
      if (!operation) throw notFound("Memory operation not found");
      if (operation.status === "promoted") {
        const existing = await tx.select().from(knowledgeRecords)
          .where(eq(knowledgeRecords.sourceMemoryOperationId, operation.id)).limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) return { operation, knowledgeRecord: existing, alreadyPromoted: true };
        throw conflict("Promoted memory operation has no knowledge record");
      }
      if (operation.status !== "candidate" || operation.reviewState !== "approved") {
        throw conflict("Memory operation must be an approved candidate before promotion");
      }
      const title = input.title ?? operation.title;
      if (!title?.trim()) throw unprocessable("Promotion requires a title");
      const provenance = buildKnowledgeProvenanceSnapshot(operation);
      const [knowledgeRecord] = await tx.insert(knowledgeRecords).values({
        companyId: operation.companyId,
        knowledgeType: input.knowledgeType ?? null,
        title,
        summary: input.summary !== undefined ? input.summary : operation.summary,
        body: input.body ?? operation.content,
        metadata: {
          ...operation.metadata,
          ...input.metadata,
          provenance,
        },
        sourceMemoryOperationId: operation.id,
        sourceIssueId: operation.sourceIssueId,
        sourceRunId: operation.sourceRunId,
        sourceAgentId: operation.sourceAgentId,
      }).returning();
      const [promoted] = await tx.update(memoryOperations).set({
        status: "promoted",
        updatedAt: new Date(),
      }).where(and(eq(memoryOperations.id, operation.id), eq(memoryOperations.status, "candidate"))).returning();
      if (!promoted) throw conflict("Memory operation changed while it was being promoted");
      return { operation: promoted, knowledgeRecord: knowledgeRecord! };
    }),

    listKnowledgeRecords: (companyId: string) => db
      .select()
      .from(knowledgeRecords)
      .where(eq(knowledgeRecords.companyId, companyId))
      .orderBy(desc(knowledgeRecords.createdAt), desc(knowledgeRecords.id)),

    getKnowledgeRecord: (id: string) => db
      .select()
      .from(knowledgeRecords)
      .where(eq(knowledgeRecords.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null),

    // Serialized per (companyId, knowledgeRecordId): concurrent sync calls
    // for the SAME record are queued and run one at a time; calls for
    // different records never wait on each other (see
    // `knowledge-record-lock.ts`). The record is re-read from the DB after
    // the lock is held, never before, so the sync always acts on the
    // latest state rather than whatever a caller saw before queuing.
    syncKnowledgeRecordObsidian: (companyId: string, id: string) => withKnowledgeRecordLock(
      knowledgeRecordLockKey(companyId, id),
      async () => {
        const existing = await db.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, id)).limit(1)
          .then((rows) => rows[0] ?? null);
        if (!existing) throw notFound("Knowledge record not found");
        const outcome = await runObsidianSync(vaultRoot, existing);
        const now = new Date();
        const [updated] = await db.update(knowledgeRecords).set(
          outcome.state === "synced"
            ? {
              obsidianPath: outcome.relativePath,
              obsidianSyncState: "synced" as const,
              obsidianSyncError: null,
              obsidianSyncedAt: now,
              updatedAt: now,
            }
            : {
              obsidianSyncState: "failed" as const,
              obsidianSyncError: outcome.error,
              updatedAt: now,
            },
        ).where(eq(knowledgeRecords.id, id)).returning();
        return { record: updated!, outcome };
      },
    ),
  };
}
