import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  accessService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import {
  effectiveApprovalStatus,
  fingerprintStatus,
  actorIdentityFor,
  requestFingerprintFor,
  checkApprovalIdempotency,
  claimApprovalIdempotency,
  completeApprovalIdempotency,
  type ApprovalRecord,
} from "../services/approval-lifecycle.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo, hasCompanyAccess } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { issueService } from "../services/issues.js";
import { REVIEW_PATH_RECOVERY_INSTRUCTION } from "../services/recovery/review-path-recovery.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

// Every approval-shaped response gets the same additive fields — existing
// consumers reading only the pre-existing keys are unaffected.
function projectApprovalResponse(approval: ApprovalRecord) {
  return {
    ...redactApprovalPayload(approval),
    effectiveStatus: effectiveApprovalStatus(approval),
    fingerprintStatus: fingerprintStatus(approval),
  };
}

function isStatusOnlyCheapRecoveryContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context.modelProfile === "cheap" &&
    context.recoveryIntent === "status_only" &&
    context.allowDeliverableWork === false &&
    context.allowDocumentUpdates === false &&
    context.resumeRequiresNormalModel === true;
}

/**
 * When the actor is a paired Board API key (mobile or CLI), record its key
 * id and scope in the audit log details — never the raw token or its hash.
 * Empty for every other actor source (session, agent key/JWT, local_implicit).
 */
function boardKeySourceDetails(req: Request): Record<string, unknown> {
  if (req.actor.source !== "board_key" || !req.actor.keyId) return {};
  return {
    boardApiKeyId: req.actor.keyId,
    boardKeyScope: req.actor.boardKeyScope ?? null,
  };
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function lostReviewPathIssueIds(
    companyId: string,
    linkedIssues: Awaited<ReturnType<typeof issueApprovalsSvc.listIssuesForApproval>>,
  ) {
    const attention = await issuesSvc.listReviewAttention(companyId, linkedIssues);
    return new Set(linkedIssues
      .filter((issue) => attention.get(issue.id)?.state === "stalled")
      .map((issue) => issue.id));
  }

  function approvalReviewPathContext(approvalId: string) {
    return {
      reviewPathLost: true,
      reviewPathConsumedRef: approvalId,
      reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
    };
  }

  async function queueAdditionalApprovalReviewPathWakes(input: {
    approvalId: string;
    approvalStatus: string;
    companyId: string;
    linkedIssues: Awaited<ReturnType<typeof issueApprovalsSvc.listIssuesForApproval>>;
    lostIssueIds: Set<string>;
    alreadyWoken?: { agentId: string; issueId: string } | null;
    requestedByUserId: string;
  }) {
    for (const issue of input.linkedIssues) {
      if (!input.lostIssueIds.has(issue.id) || !issue.assigneeAgentId) continue;
      if (
        input.alreadyWoken?.agentId === issue.assigneeAgentId
        && input.alreadyWoken.issueId === issue.id
      ) continue;

      const wakeReason = `approval_${input.approvalStatus}`;
      try {
        const wakeRun = await heartbeat.wakeup(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: wakeReason,
          idempotencyKey: `approval-review-path:${input.approvalId}:${issue.id}:${input.approvalStatus}`,
          payload: {
            approvalId: input.approvalId,
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            ...approvalReviewPathContext(input.approvalId),
          },
          requestedByActorType: "user",
          requestedByActorId: input.requestedByUserId,
          contextSnapshot: {
            source: `approval.${input.approvalStatus}`,
            approvalId: input.approvalId,
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            taskId: issue.id,
            wakeReason,
            ...approvalReviewPathContext(input.approvalId),
          },
        });

        await logActivity(db, {
          companyId: input.companyId,
          actorType: "user",
          actorId: input.requestedByUserId,
          action: "approval.review_path_wakeup_queued",
          entityType: "approval",
          entityId: input.approvalId,
          details: {
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            wakeRunId: wakeRun?.id ?? null,
          },
        });
      } catch (err) {
        logger.warn(
          { err, approvalId: input.approvalId, issueId: issue.id, agentId: issue.assigneeAgentId },
          "failed to queue review-path wake after approval resolution",
        );
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "user",
          actorId: input.requestedByUserId,
          action: "approval.review_path_wakeup_failed",
          entityType: "approval",
          entityId: input.approvalId,
          details: {
            approvalStatus: input.approvalStatus,
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  }

  // Extracted verbatim from the former inline `if (applied) { ... }` body of
  // POST /approvals/:id/approve, so both the idempotencyKey path and the
  // plain path below call the exact same wakeup/review-path logic instead of
  // maintaining two copies that could silently drift apart.
  async function runApproveSideEffects(req: Request, approval: ApprovalRecord) {
    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
    const linkedIssueIds = linkedIssues.map((issue) => issue.id);
    const primaryIssueId = linkedIssueIds[0] ?? null;
    const lostReviewIssueIds = await lostReviewPathIssueIds(approval.companyId, linkedIssues);
    const primaryReviewPathContext = primaryIssueId && lostReviewIssueIds.has(primaryIssueId)
      ? approvalReviewPathContext(approval.id)
      : null;

    let primaryReviewPathWakeCovered = false;
    if (approval.requestedByAgentId) {
      try {
        const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "approval_approved",
          payload: {
            approvalId: approval.id,
            approvalStatus: approval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
            ...(primaryReviewPathContext ?? {}),
          },
          requestedByActorType: "user",
          requestedByActorId: req.actor.userId ?? "board",
          contextSnapshot: {
            source: "approval.approved",
            approvalId: approval.id,
            approvalStatus: approval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
            taskId: primaryIssueId,
            wakeReason: "approval_approved",
            ...(primaryReviewPathContext ?? {}),
          },
        });
        primaryReviewPathWakeCovered = Boolean(wakeRun && primaryReviewPathContext);

        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "approval.requester_wakeup_queued",
          entityType: "approval",
          entityId: approval.id,
          details: {
            requesterAgentId: approval.requestedByAgentId,
            wakeRunId: wakeRun?.id ?? null,
            linkedIssueIds,
          },
        });
      } catch (err) {
        logger.warn(
          {
            err,
            approvalId: approval.id,
            requestedByAgentId: approval.requestedByAgentId,
          },
          "failed to queue requester wakeup after approval",
        );
        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "approval.requester_wakeup_failed",
          entityType: "approval",
          entityId: approval.id,
          details: {
            requesterAgentId: approval.requestedByAgentId,
            linkedIssueIds,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    await queueAdditionalApprovalReviewPathWakes({
      approvalId: approval.id,
      approvalStatus: approval.status,
      companyId: approval.companyId,
      linkedIssues,
      lostIssueIds: lostReviewIssueIds,
      alreadyWoken: primaryReviewPathWakeCovered && approval.requestedByAgentId && primaryIssueId
        ? { agentId: approval.requestedByAgentId, issueId: primaryIssueId }
        : null,
      requestedByUserId: req.actor.userId ?? "board",
    });
  }

  // Extracted verbatim from the former inline `if (applied) { ... }` body of
  // POST /approvals/:id/reject.
  async function runRejectSideEffects(req: Request, approval: ApprovalRecord) {
    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
    const lostReviewIssueIds = await lostReviewPathIssueIds(approval.companyId, linkedIssues);
    await queueAdditionalApprovalReviewPathWakes({
      approvalId: approval.id,
      approvalStatus: approval.status,
      companyId: approval.companyId,
      linkedIssues,
      lostIssueIds: lostReviewIssueIds,
      requestedByUserId: req.actor.userId ?? "board",
    });
  }

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval || !hasCompanyAccess(req, approval.companyId)) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  async function assertApprovalAccessAllowed(req: Request, res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Approvals are outside this actor's authorization boundary" });
    return false;
  }

  async function assertApprovalMutationAllowedByRunContext(req: Request, res: any, companyId: string) {
    if (req.actor.type !== "agent") return true;
    const runId = req.actor.runId?.trim();
    if (!runId || !req.actor.agentId) return true;

    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return true;
    if (!isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot create or modify approvals",
      details: {
        companyId,
        runId: run.id,
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => projectApprovalResponse(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    res.json(projectApprovalResponse(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, companyId))) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(projectApprovalResponse(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existingApproval = await requireApprovalAccess(req, id);
    if (!existingApproval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const idempotencyKey = req.body.idempotencyKey as string | undefined;

    if (!idempotencyKey) {
      const { approval, applied, outcome } = await svc.approve(id, decidedByUserId, req.body.decisionNote);

      if (outcome === "expired") {
        res.status(410).json({
          error: "This approval has expired and can no longer be resolved",
          reason: "approval_expired",
          expiredAt: approval.expiresAt?.toISOString() ?? null,
        });
        return;
      }
      if (outcome === "conflict") {
        res.status(409).json({
          error: "This approval was already resolved to a different status",
          reason: "already_resolved_conflict",
          currentStatus: approval.status,
        });
        return;
      }

      if (applied) {
        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: decidedByUserId,
          action: "approval.approved",
          entityType: "approval",
          entityId: approval.id,
          details: {
            type: approval.type,
            requestedByAgentId: approval.requestedByAgentId,
            ...boardKeySourceDetails(req),
          },
        });
        await runApproveSideEffects(req, approval);
      }

      res.json(projectApprovalResponse(approval));
      return;
    }

    // idempotencyKey path — access already checked above (requireApprovalAccess).
    const actorIdentity = actorIdentityFor(req);
    const requestFingerprint = requestFingerprintFor({ decisionNote: req.body.decisionNote });

    const fastPath = await checkApprovalIdempotency(db, {
      actorIdentity, idempotencyKey, approvalId: id, action: "approve", requestFingerprint,
    });
    if (fastPath.kind === "key_reused_with_different_request") {
      res.status(409).json({
        error: "This idempotency key was already used with a different approval, action, or request body",
        reason: "idempotency_key_reused",
      });
      return;
    }
    if (fastPath.kind === "replay") {
      res.status(fastPath.httpStatus).json(fastPath.body);
      return;
    }

    let applied = false;
    let httpStatus = 200;
    let body: unknown;
    let approvalForSideEffects: ApprovalRecord | null = null;

    await db.transaction(async (tx) => {
      const claim = await claimApprovalIdempotency(tx as unknown as Db, {
        companyId: existingApproval.companyId, actorIdentity, idempotencyKey, approvalId: id, action: "approve", requestFingerprint,
      });

      if (claim.kind === "lost_conflict") {
        httpStatus = 409;
        body = {
          error: "This idempotency key was already used with a different approval, action, or request body",
          reason: "idempotency_key_reused",
        };
        return;
      }
      if (claim.kind === "lost_replay") {
        httpStatus = claim.httpStatus;
        body = claim.body;
        return;
      }

      const result = await approvalService(tx as unknown as Db).approve(id, decidedByUserId, req.body.decisionNote);
      applied = result.applied;

      if (result.outcome === "expired") {
        httpStatus = 410;
        body = {
          error: "This approval has expired and can no longer be resolved",
          reason: "approval_expired",
          expiredAt: result.approval.expiresAt?.toISOString() ?? null,
        };
      } else if (result.outcome === "conflict") {
        httpStatus = 409;
        body = {
          error: "This approval was already resolved to a different status",
          reason: "already_resolved_conflict",
          currentStatus: result.approval.status,
        };
      } else {
        if (result.applied) {
          await logActivity(tx as unknown as Db, {
            companyId: result.approval.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "approval.approved",
            entityType: "approval",
            entityId: result.approval.id,
            details: {
              type: result.approval.type,
              requestedByAgentId: result.approval.requestedByAgentId,
              ...boardKeySourceDetails(req),
            },
          });
        }
        httpStatus = 200;
        body = projectApprovalResponse(result.approval);
        approvalForSideEffects = result.approval;
      }

      await completeApprovalIdempotency(tx as unknown as Db, { claimId: claim.claimId, httpStatus, body });
    });

    if (applied && approvalForSideEffects) {
      await runApproveSideEffects(req, approvalForSideEffects);
    }

    res.status(httpStatus).json(body);
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existingApproval = await requireApprovalAccess(req, id);
    if (!existingApproval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const idempotencyKey = req.body.idempotencyKey as string | undefined;

    if (!idempotencyKey) {
      const { approval, applied, outcome } = await svc.reject(id, decidedByUserId, req.body.decisionNote);

      if (outcome === "expired") {
        res.status(410).json({
          error: "This approval has expired and can no longer be resolved",
          reason: "approval_expired",
          expiredAt: approval.expiresAt?.toISOString() ?? null,
        });
        return;
      }
      if (outcome === "conflict") {
        res.status(409).json({
          error: "This approval was already resolved to a different status",
          reason: "already_resolved_conflict",
          currentStatus: approval.status,
        });
        return;
      }

      if (applied) {
        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: decidedByUserId,
          action: "approval.rejected",
          entityType: "approval",
          entityId: approval.id,
          details: { type: approval.type, ...boardKeySourceDetails(req) },
        });
        await runRejectSideEffects(req, approval);
      }

      res.json(projectApprovalResponse(approval));
      return;
    }

    const actorIdentity = actorIdentityFor(req);
    const requestFingerprint = requestFingerprintFor({ decisionNote: req.body.decisionNote });

    const fastPath = await checkApprovalIdempotency(db, {
      actorIdentity, idempotencyKey, approvalId: id, action: "reject", requestFingerprint,
    });
    if (fastPath.kind === "key_reused_with_different_request") {
      res.status(409).json({
        error: "This idempotency key was already used with a different approval, action, or request body",
        reason: "idempotency_key_reused",
      });
      return;
    }
    if (fastPath.kind === "replay") {
      res.status(fastPath.httpStatus).json(fastPath.body);
      return;
    }

    let applied = false;
    let httpStatus = 200;
    let body: unknown;
    let approvalForSideEffects: ApprovalRecord | null = null;

    await db.transaction(async (tx) => {
      const claim = await claimApprovalIdempotency(tx as unknown as Db, {
        companyId: existingApproval.companyId, actorIdentity, idempotencyKey, approvalId: id, action: "reject", requestFingerprint,
      });

      if (claim.kind === "lost_conflict") {
        httpStatus = 409;
        body = {
          error: "This idempotency key was already used with a different approval, action, or request body",
          reason: "idempotency_key_reused",
        };
        return;
      }
      if (claim.kind === "lost_replay") {
        httpStatus = claim.httpStatus;
        body = claim.body;
        return;
      }

      const result = await approvalService(tx as unknown as Db).reject(id, decidedByUserId, req.body.decisionNote);
      applied = result.applied;

      if (result.outcome === "expired") {
        httpStatus = 410;
        body = {
          error: "This approval has expired and can no longer be resolved",
          reason: "approval_expired",
          expiredAt: result.approval.expiresAt?.toISOString() ?? null,
        };
      } else if (result.outcome === "conflict") {
        httpStatus = 409;
        body = {
          error: "This approval was already resolved to a different status",
          reason: "already_resolved_conflict",
          currentStatus: result.approval.status,
        };
      } else {
        if (result.applied) {
          await logActivity(tx as unknown as Db, {
            companyId: result.approval.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "approval.rejected",
            entityType: "approval",
            entityId: result.approval.id,
            details: { type: result.approval.type, ...boardKeySourceDetails(req) },
          });
        }
        httpStatus = 200;
        body = projectApprovalResponse(result.approval);
        approvalForSideEffects = result.approval;
      }

      await completeApprovalIdempotency(tx as unknown as Db, { claimId: claim.claimId, httpStatus, body });
    });

    if (applied && approvalForSideEffects) {
      await runRejectSideEffects(req, approvalForSideEffects);
    }

    res.status(httpStatus).json(body);
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existingApproval = await requireApprovalAccess(req, id);
      if (!existingApproval) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const idempotencyKey = req.body.idempotencyKey as string | undefined;

      if (!idempotencyKey) {
        const { approval, applied, outcome } = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

        if (outcome === "expired") {
          res.status(410).json({
            error: "This approval has expired and can no longer be resolved",
            reason: "approval_expired",
            expiredAt: approval.expiresAt?.toISOString() ?? null,
          });
          return;
        }
        if (outcome === "conflict") {
          res.status(409).json({
            error: "This approval was already resolved to a different status",
            reason: "already_resolved_conflict",
            currentStatus: approval.status,
          });
          return;
        }

        if (applied) {
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "approval.revision_requested",
            entityType: "approval",
            entityId: approval.id,
            details: { type: approval.type, ...boardKeySourceDetails(req) },
          });
        }

        res.json(projectApprovalResponse(approval));
        return;
      }

      const actorIdentity = actorIdentityFor(req);
      const requestFingerprint = requestFingerprintFor({ decisionNote: req.body.decisionNote });

      const fastPath = await checkApprovalIdempotency(db, {
        actorIdentity, idempotencyKey, approvalId: id, action: "request_revision", requestFingerprint,
      });
      if (fastPath.kind === "key_reused_with_different_request") {
        res.status(409).json({
          error: "This idempotency key was already used with a different approval, action, or request body",
          reason: "idempotency_key_reused",
        });
        return;
      }
      if (fastPath.kind === "replay") {
        res.status(fastPath.httpStatus).json(fastPath.body);
        return;
      }

      let httpStatus = 200;
      let body: unknown;

      await db.transaction(async (tx) => {
        const claim = await claimApprovalIdempotency(tx as unknown as Db, {
          companyId: existingApproval.companyId, actorIdentity, idempotencyKey, approvalId: id, action: "request_revision", requestFingerprint,
        });

        if (claim.kind === "lost_conflict") {
          httpStatus = 409;
          body = {
            error: "This idempotency key was already used with a different approval, action, or request body",
            reason: "idempotency_key_reused",
          };
          return;
        }
        if (claim.kind === "lost_replay") {
          httpStatus = claim.httpStatus;
          body = claim.body;
          return;
        }

        const result = await approvalService(tx as unknown as Db).requestRevision(id, decidedByUserId, req.body.decisionNote);

        if (result.outcome === "expired") {
          httpStatus = 410;
          body = {
            error: "This approval has expired and can no longer be resolved",
            reason: "approval_expired",
            expiredAt: result.approval.expiresAt?.toISOString() ?? null,
          };
        } else if (result.outcome === "conflict") {
          httpStatus = 409;
          body = {
            error: "This approval was already resolved to a different status",
            reason: "already_resolved_conflict",
            currentStatus: result.approval.status,
          };
        } else {
          if (result.applied) {
            await logActivity(tx as unknown as Db, {
              companyId: result.approval.companyId,
              actorType: "user",
              actorId: decidedByUserId,
              action: "approval.revision_requested",
              entityType: "approval",
              entityId: result.approval.id,
              details: { type: result.approval.type, ...boardKeySourceDetails(req) },
            });
          }
          httpStatus = 200;
          body = projectApprovalResponse(result.approval);
        }

        await completeApprovalIdempotency(tx as unknown as Db, { claimId: claim.claimId, httpStatus, body });
      });

      res.status(httpStatus).json(body);
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!existing) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId))) return;

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(projectApprovalResponse(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await getAccessibleResource(req, res, svc.getById(id), "Approval not found");
    if (!approval) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, approval.companyId))) return;
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id, ...boardKeySourceDetails(req) },
    });

    res.status(201).json(comment);
  });

  return router;
}
