import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  heartbeatRuns,
  issues,
  knowledgeRecords,
  knowledgeRecordRevisions,
  memoryOperations,
} from "@paperclipai/db";
import type { MemorySourceType } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { knowledgeRecordLockKey, withKnowledgeRecordLock } from "./knowledge-record-lock.js";
import {
  getActiveKnowledgeBackendId,
  getKnowledgeBackend,
  type KnowledgeBackend,
  type ObsidianSyncFn,
} from "./knowledge-backend.js";

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

export type ListKnowledgeRecordsOptions = {
  q?: string;
  limit?: number;
};

// M2-03-B01: baseRevisionId is required and compared against the record's
// current latestRevisionId — same optimistic-concurrency contract as
// documents.ts's updateDocument. A caller who doesn't know the current
// revision cannot blindly overwrite it.
type UpdateKnowledgeRecordInput = {
  baseRevisionId: string;
  knowledgeType?: string | null;
  title?: string;
  summary?: string | null;
  body?: string;
  confidence?: number | null;
  changeSummary?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  createdByRunId?: string | null;
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

// F-07 generic entry point: the architectural call this generic service
// exposes is knowledge record -> F-08 KnowledgeBackend registry -> active
// backend -> writeRecord(). Both the existing Board-only manual route
// (via knowledgeService().syncKnowledgeRecordObsidian, kept for backward
// compatibility — see below) and the F-07 automatic reconciler call this
// SAME function, so a manual and an automatic sync for the same record
// always serialize on the same per-record lock and can never race. Never
// imported directly as `obsidian-sync.ts` by the reconciler — see
// docs/contracts/nexora-f07-knowledge-auto-save.md.
export function syncKnowledgeRecordToBackend(db: Db, backend: KnowledgeBackend, companyId: string, id: string) {
  return withKnowledgeRecordLock(
    knowledgeRecordLockKey(companyId, id),
    async () => {
      const existing = await db.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, id)).limit(1)
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Knowledge record not found");
      const outcome = await backend.writeRecord({
        id: existing.id,
        companyId: existing.companyId,
        title: existing.title,
        summary: existing.summary,
        body: existing.body,
        // Prefer the legacy obsidianPath for backward compatibility: every
        // write this generic function performs sets obsidianPath and
        // externalRef identically (see below), so they only ever diverge
        // for a row written through some other path (a historical pre-F-08
        // record, or a direct DB write) — in which case obsidianPath is the
        // long-standing field of record and must be honored, never silently
        // dropped in favor of a possibly-still-null generic column.
        externalRef: existing.obsidianPath ?? existing.externalRef,
      });
      const now = new Date();
      const [updated] = await db.update(knowledgeRecords).set(
        outcome.state === "synced"
          ? {
            // obsidian* columns kept in sync alongside the generic
            // external* columns for backward compatibility — see
            // docs/contracts/nexora-f08-knowledge-backend-architecture.md.
            obsidianPath: outcome.externalRef,
            obsidianSyncState: "synced" as const,
            obsidianSyncError: null,
            obsidianSyncedAt: now,
            externalBackendId: backend.id,
            externalRef: outcome.externalRef,
            externalSyncState: "synced" as const,
            externalSyncError: null,
            externalSyncedAt: now,
            updatedAt: now,
          }
          : {
            obsidianSyncState: "failed" as const,
            obsidianSyncError: outcome.error,
            externalBackendId: backend.id,
            externalSyncState: "failed" as const,
            externalSyncError: outcome.error,
            updatedAt: now,
          },
      ).where(eq(knowledgeRecords.id, id)).returning();
      return { record: updated!, outcome };
    },
  );
}

export type KnowledgeServiceOptions = {
  /** Obsidian-specific overrides, threaded through to the "obsidian" KnowledgeBackend when it is the active (or explicitly selected) backend. */
  obsidianVaultRoot?: string | null;
  /** Test-only seam: overrides the actual filesystem sync implementation. */
  obsidianSyncFn?: ObsidianSyncFn;
  /** Overrides which registered backend is used; defaults to getActiveKnowledgeBackendId(). */
  knowledgeBackendId?: string;
};

export function knowledgeService(db: Db, options: KnowledgeServiceOptions = {}) {
  // F-08: knowledge service -> KnowledgeBackend registry -> active backend
  // (Obsidian in v1). Unknown backend ids fail closed inside getKnowledgeBackend.
  const backend = getKnowledgeBackend(
    options.knowledgeBackendId ?? getActiveKnowledgeBackendId(),
    { obsidianVaultRoot: options.obsidianVaultRoot, obsidianSyncFn: options.obsidianSyncFn },
  );
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
      const knowledgeType = input.knowledgeType ?? null;
      const summary = input.summary !== undefined ? input.summary : operation.summary;
      const body = input.body ?? operation.content;
      const [knowledgeRecord] = await tx.insert(knowledgeRecords).values({
        companyId: operation.companyId,
        knowledgeType,
        title,
        summary,
        body,
        metadata: {
          ...operation.metadata,
          ...input.metadata,
          provenance,
        },
        sourceMemoryOperationId: operation.id,
        sourceIssueId: operation.sourceIssueId,
        sourceRunId: operation.sourceRunId,
        sourceAgentId: operation.sourceAgentId,
        // F-07: the ONE human approval that already gates promotion
        // (reviewState must be "approved" before promotion is even
        // possible, checked above) also authorizes the automatic backend
        // save — explicitly marking this record eligible for the F-07
        // reconciler. A historical pre-F-07 record's externalSyncState
        // stays NULL (the column default) and is never auto-selected — see
        // knowledge-auto-save-reconciler.ts's eligibility query, which
        // matches only "pending"/"failed", never NULL.
        externalSyncState: "pending",
        // M2-03-B01: confidence is carried through UNCHANGED from the
        // candidate's own confidence — never recomputed, never bumped —
        // because promotion (a human approving a candidate) is not itself
        // new independent evidence about the content's truth.
        confidence: operation.confidence,
        revisionNumber: 1,
      }).returning();
      // M2-03-B01: revision 1 is created in the SAME transaction as the
      // knowledge record itself, so a record can never exist without its
      // own first revision snapshot.
      const [revision] = await tx.insert(knowledgeRecordRevisions).values({
        companyId: operation.companyId,
        knowledgeRecordId: knowledgeRecord!.id,
        revisionNumber: 1,
        knowledgeType,
        title,
        summary,
        body,
        confidence: operation.confidence,
        changeSummary: "Initial promotion from memory candidate.",
        createdByAgentId: operation.reviewedByAgentId,
        createdByRunId: operation.sourceRunId,
      }).returning();
      const [withRevisionPointer] = await tx.update(knowledgeRecords).set({
        latestRevisionId: revision!.id,
      }).where(eq(knowledgeRecords.id, knowledgeRecord!.id)).returning();
      const [promoted] = await tx.update(memoryOperations).set({
        status: "promoted",
        updatedAt: new Date(),
      }).where(and(eq(memoryOperations.id, operation.id), eq(memoryOperations.status, "candidate"))).returning();
      if (!promoted) throw conflict("Memory operation changed while it was being promoted");
      return { operation: promoted, knowledgeRecord: withRevisionPointer! };
    }),

    // M2-03-B01: the first edit entrypoint for an already-promoted knowledge
    // record. Optimistic concurrency via baseRevisionId, exactly matching
    // documents.ts's updateDocument contract — a caller that doesn't know
    // the current revision can never blindly overwrite it. Confidence is
    // carried through unchanged unless the caller explicitly passes a new
    // value (e.g. because genuinely new independent evidence was found);
    // this function never increases it on its own.
    updateKnowledgeRecord: async (id: string, input: UpdateKnowledgeRecordInput) => db.transaction(async (tx) => {
      const existing = await tx.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, id)).limit(1)
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Knowledge record not found");
      if (input.baseRevisionId !== existing.latestRevisionId) {
        throw conflict("Knowledge record was updated by someone else", {
          currentRevisionId: existing.latestRevisionId,
        });
      }
      const nextRevisionNumber = existing.revisionNumber + 1;
      const knowledgeType = input.knowledgeType !== undefined ? input.knowledgeType : existing.knowledgeType;
      const title = input.title ?? existing.title;
      const summary = input.summary !== undefined ? input.summary : existing.summary;
      const body = input.body ?? existing.body;
      const confidence = input.confidence !== undefined ? input.confidence : existing.confidence;
      const [revision] = await tx.insert(knowledgeRecordRevisions).values({
        companyId: existing.companyId,
        knowledgeRecordId: existing.id,
        revisionNumber: nextRevisionNumber,
        knowledgeType,
        title,
        summary,
        body,
        confidence,
        changeSummary: input.changeSummary ?? null,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByRunId: input.createdByRunId ?? null,
      }).returning();
      const [updated] = await tx.update(knowledgeRecords).set({
        knowledgeType,
        title,
        summary,
        body,
        confidence,
        latestRevisionId: revision!.id,
        revisionNumber: nextRevisionNumber,
        updatedAt: new Date(),
      }).where(and(eq(knowledgeRecords.id, id), eq(knowledgeRecords.latestRevisionId, input.baseRevisionId)))
        .returning();
      if (!updated) throw conflict("Knowledge record was updated by someone else", {
        currentRevisionId: existing.latestRevisionId,
      });
      return { knowledgeRecord: updated, revision: revision! };
    }),

    listKnowledgeRecordRevisions: (knowledgeRecordId: string) => db
      .select()
      .from(knowledgeRecordRevisions)
      .where(eq(knowledgeRecordRevisions.knowledgeRecordId, knowledgeRecordId))
      .orderBy(desc(knowledgeRecordRevisions.revisionNumber)),

    listKnowledgeRecords: (companyId: string, options?: ListKnowledgeRecordsOptions) => {
      const conditions = [eq(knowledgeRecords.companyId, companyId)];
      const trimmed = options?.q?.trim();
      if (trimmed) {
        const pattern = `%${trimmed}%`;
        conditions.push(
          or(
            ilike(knowledgeRecords.title, pattern),
            ilike(knowledgeRecords.summary, pattern),
            ilike(knowledgeRecords.body, pattern),
          )!,
        );
      }
      const baseQuery = db
        .select()
        .from(knowledgeRecords)
        .where(and(...conditions))
        .orderBy(desc(knowledgeRecords.createdAt), desc(knowledgeRecords.id));
      if (typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0) {
        return baseQuery.limit(Math.min(Math.floor(options.limit), 500));
      }
      return baseQuery;
    },

    getKnowledgeRecord: (id: string) => db
      .select()
      .from(knowledgeRecords)
      .where(eq(knowledgeRecords.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null),

    // Backward-compatible delegate to the F-07 generic entry point above —
    // the Board-only manual route's behavior, request/response shape, and
    // per-record locking are unchanged; it now simply shares its
    // implementation (and its lock key) with the automatic reconciler
    // instead of duplicating it.
    syncKnowledgeRecordObsidian: (companyId: string, id: string) =>
      syncKnowledgeRecordToBackend(db, backend, companyId, id),
  };
}
