import { Router } from "express";
import { eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import {
  createMemoryOperationSchema,
  extractMemoryOperationCandidateRequestSchema,
  obsidianSyncRequestSchema,
  promoteMemoryOperationSchema,
  reviewMemoryOperationSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { knowledgeService, logActivity } from "../services/index.js";
import type { KnowledgeServiceOptions } from "../services/knowledge.js";
import { extractMemoryOperationCandidateFromCompletedIssue } from "../services/memory-candidate-extraction.js";
import { assertCompanyAccess, assertBoard, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";

export function knowledgeRoutes(db: Db, options: KnowledgeServiceOptions = {}) {
  const router = Router();
  const service = knowledgeService(db, options);

  router.post("/companies/:companyId/memory-operations", validate(createMemoryOperationSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const operation = await service.createMemoryOperation({ companyId, ...req.body });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory_operation.created",
      entityType: "memory_operation",
      entityId: operation.id,
      issueId: operation.sourceIssueId,
      details: { sourceType: operation.sourceType, sourceId: operation.sourceId },
    });
    res.status(201).json(operation);
  });

  router.get("/companies/:companyId/memory-operations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.listMemoryOperations(companyId));
  });

  router.post("/memory-operations/:id/review", validate(reviewMemoryOperationSchema), async (req, res) => {
    assertBoard(req);
    const existing = await getAccessibleResource(
      req,
      res,
      service.getMemoryOperation(req.params.id as string),
      "Memory operation not found",
    );
    if (!existing) return;
    const actor = getActorInfo(req);
    const operation = await service.reviewMemoryOperation(existing.id, {
      ...req.body,
      reviewedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
    });
    await logActivity(db, {
      companyId: operation.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory_operation.reviewed",
      entityType: "memory_operation",
      entityId: operation.id,
      issueId: operation.sourceIssueId,
      details: { reviewState: operation.reviewState },
    });
    res.json(operation);
  });

  router.post("/memory-operations/:id/promote", validate(promoteMemoryOperationSchema), async (req, res) => {
    assertBoard(req);
    const existing = await getAccessibleResource(
      req,
      res,
      service.getMemoryOperation(req.params.id as string),
      "Memory operation not found",
    );
    if (!existing) return;
    const result = await service.promoteMemoryOperation(existing.id, req.body);
    if (result.alreadyPromoted) {
      res.json({ operation: result.operation, knowledgeRecord: result.knowledgeRecord });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.operation.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory_operation.promoted",
      entityType: "knowledge_record",
      entityId: result.knowledgeRecord.id,
      issueId: result.operation.sourceIssueId,
      details: { sourceMemoryOperationId: result.operation.id },
    });
    res.status(201).json(result);
  });

  router.get("/companies/:companyId/knowledge-records", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.listKnowledgeRecords(companyId));
  });

  router.get("/knowledge-records/:id", async (req, res) => {
    const record = await getAccessibleResource(
      req,
      res,
      service.getKnowledgeRecord(req.params.id as string),
      "Knowledge record not found",
    );
    if (!record) return;
    res.json(record);
  });

  router.post(
    "/knowledge-records/:id/obsidian-sync",
    validate(obsidianSyncRequestSchema),
    async (req, res) => {
      // Board-only, checked before any DB lookup: syncing to the operator's
      // local filesystem is a human-governed action, never delegated to an
      // agent actor (Phase 2.2 confirmed contract).
      assertBoard(req);
      const existing = await getAccessibleResource(
        req,
        res,
        service.getKnowledgeRecord(req.params.id as string),
        "Knowledge record not found",
      );
      if (!existing) return;
      const { record, outcome } = await service.syncKnowledgeRecordObsidian(existing.companyId, existing.id);
      if (outcome.state === "synced") {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: record.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "knowledge_record.obsidian_synced",
          entityType: "knowledge_record",
          entityId: record.id,
          details: { obsidianPath: record.obsidianPath },
        });
      }
      res.json(record);
    },
  );

  router.post(
    "/issues/:id/extract-memory-candidate",
    validate(extractMemoryOperationCandidateRequestSchema),
    async (req, res) => {
      // Phase 3.0A: an explicit, Board-only extraction call. assertBoard runs
      // before any DB lookup — an agent actor gets 403 without learning
      // whether the issue exists, matches review/promote/obsidian-sync's
      // ordering. Nothing here runs automatically from issue completion —
      // Core's completion transition (server/src/services/issues.ts) and
      // heartbeat.ts are untouched. A hypothetical future Phase 3.0B
      // (automatic extraction wired into that completion transition) would
      // have no human caller and would need its own system-actor
      // attribution — see the module doc comment in
      // memory-candidate-extraction.ts.
      assertBoard(req);
      const issueId = req.params.id as string;
      const issueRow = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!issueRow || !hasCompanyAccess(req, issueRow.companyId)) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issueRow.companyId);

      const actor = getActorInfo(req);
      const outcome = await extractMemoryOperationCandidateFromCompletedIssue(
        db,
        issueRow.companyId,
        issueRow.id,
        actor,
      );

      if (outcome.outcome === "created") {
        // The candidate row and its "memory_operation.extracted" activity
        // log entry were already persisted together, in the same DB
        // transaction, inside extractMemoryOperationCandidateFromCompletedIssue
        // — attributed to the real calling Board actor, not a synthetic
        // system identity, since a human explicitly asked for this.
        res.status(201).json({ created: true, memoryOperation: outcome.operation });
        return;
      }

      if (outcome.outcome === "deduplicated") {
        res.status(200).json({ created: false, reason: "already_extracted", memoryOperation: outcome.operation });
        return;
      }

      res.status(200).json({ created: false, reason: outcome.reason });
    },
  );

  return router;
}
