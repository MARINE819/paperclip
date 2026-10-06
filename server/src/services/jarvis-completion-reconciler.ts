import { activityLog, type Db } from "@paperclipai/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { HttpError } from "../errors.js";
import { issueApprovalService } from "./issue-approvals.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import {
  assertIssueReviewVerdictActorAllowed,
  type IssueReviewVerdictActor,
} from "./issue-review-policy.js";
import { issueService } from "./issues.js";
import { evaluateEvidenceAcceptance, type JarvisEvidenceAcceptanceResult } from "./jarvis-evidence-acceptance.js";
import { workProductService } from "./work-products.js";

type ApprovalSummary = { id: string; status: string };

interface ReconciliationContext {
  parentIssueId: string;
  childIssueId: string;
  childStatus: string;
  executionState: ReturnType<typeof parseIssueExecutionState>;
  approvalRequired: boolean;
  reviewRequired?: boolean;
  approvals: ApprovalSummary[];
}

export type JarvisCompletionReconciliationResult =
  | (ReconciliationContext & {
      outcome: "ready_for_jarvis_review";
      evidence: JarvisEvidenceAcceptanceResult;
      reviewer?: IssueReviewVerdictActor | null;
    })
  | (ReconciliationContext & { outcome: "awaiting_independent_review" })
  | (ReconciliationContext & { outcome: "child_not_terminal" })
  | (ReconciliationContext & { outcome: "missing_evidence"; evidence: JarvisEvidenceAcceptanceResult })
  | (ReconciliationContext & { outcome: "invalid_or_unreadable_work_product"; evidence: JarvisEvidenceAcceptanceResult })
  | (ReconciliationContext & { outcome: "pending_human_approval"; approvalId: string })
  | (ReconciliationContext & { outcome: "revision_required"; approvalId?: string; reason?: string })
  | (ReconciliationContext & { outcome: "approval_rejected"; approvalId: string })
  | (ReconciliationContext & { outcome: "missing_required_approval" })
  | (ReconciliationContext & { outcome: "missing_independent_review"; reason: "missing_reviewer" | "unable_to_verify_review_authorization" | string })
  | (ReconciliationContext & { outcome: "invalid_reviewer"; reason: "executor_cannot_self_review" | "review_policy_denied" | string })
  | { outcome: "invalid_company_or_issue_relationship"; reason: "issue_not_found" | "company_mismatch" | "parent_mismatch" | "child_not_in_accepted_plan" };

async function resolveIssueReviewVerdictActor(
  db: Db,
  issue: { id: string; companyId: string },
): Promise<IssueReviewVerdictActor | null> {
  if (!db || typeof (db as { select?: unknown }).select !== "function") return null;
  try {
    const transition = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, issue.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issue.id),
        eq(activityLog.action, "issue.updated"),
        sql`(
          (
            ${activityLog.details} ->> 'status' = 'done'
            AND ${activityLog.details} -> '_previous' ->> 'status' = 'in_review'
          )
          OR
          (
            ${activityLog.details} -> 'changes' -> 'status' ->> 'to' = 'done'
            AND ${activityLog.details} -> 'changes' -> 'status' ->> 'from' = 'in_review'
          )
        )`,
      ))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (transition?.actorType === "agent" || transition?.actorType === "user") {
      return { type: transition.actorType, id: transition.actorId };
    }
  } catch {
    return null;
  }
  return null;
}

export async function reconcileDelegatedChildCompletion(
  db: Db,
  input: {
    companyId: string;
    parentIssueId: string;
    resolvedChildIssueId: string;
    reviewRequired?: boolean;
  },
): Promise<JarvisCompletionReconciliationResult> {
  const issues = issueService(db);
  const [parent, child] = await Promise.all([
    issues.getById(input.parentIssueId),
    issues.getById(input.resolvedChildIssueId),
  ]);
  if (!parent || !child) return { outcome: "invalid_company_or_issue_relationship", reason: "issue_not_found" };
  if (parent.companyId !== input.companyId || child.companyId !== input.companyId) {
    return { outcome: "invalid_company_or_issue_relationship", reason: "company_mismatch" };
  }
  if (child.parentId !== parent.id) {
    return { outcome: "invalid_company_or_issue_relationship", reason: "parent_mismatch" };
  }
  const decompositions = await issues.listAcceptedPlanDecompositions(parent.id);
  if (!decompositions.some((entry) => entry.childIssueIds.includes(child.id))) {
    return { outcome: "invalid_company_or_issue_relationship", reason: "child_not_in_accepted_plan" };
  }

  const reviewRequired = child.reviewPolicy === "not_creator" || Boolean(input.reviewRequired);
  const executionState = parseIssueExecutionState(child.executionState);
  const approvalRequired = executionState?.status === "pending" && executionState.currentParticipant?.type === "user";
  const linkedApprovals = await issueApprovalService(db).listApprovalsForIssue(child.id);
  const approvals = linkedApprovals.map(({ id, status }) => ({ id, status }));
  const context: ReconciliationContext = {
    parentIssueId: parent.id,
    childIssueId: child.id,
    childStatus: child.status,
    executionState,
    approvalRequired,
    reviewRequired,
    approvals,
  };

  if (reviewRequired && child.status === "in_review") {
    return { ...context, outcome: "awaiting_independent_review" };
  }

  if (child.status !== "done") return { ...context, outcome: "child_not_terminal" };

  const blockingApproval = linkedApprovals.find((approval) => approval.status !== "approved");
  if (blockingApproval?.status === "pending") {
    return { ...context, outcome: "pending_human_approval", approvalId: blockingApproval.id };
  }
  if (blockingApproval?.status === "revision_requested") {
    return { ...context, outcome: "revision_required", approvalId: blockingApproval.id };
  }
  if (blockingApproval?.status === "rejected") {
    return { ...context, outcome: "approval_rejected", approvalId: blockingApproval.id };
  }
  if (approvalRequired && linkedApprovals.length === 0) {
    return { ...context, outcome: "missing_required_approval" };
  }

  if (
    reviewRequired &&
    (executionState?.status === "changes_requested" ||
      executionState?.lastDecisionOutcome === "changes_requested")
  ) {
    return { ...context, outcome: "revision_required", reason: "changes_requested" };
  }

  const workProducts = await workProductService(db).listForIssue(child.id);
  const evidence = evaluateEvidenceAcceptance({ childIssueId: child.id, workProducts });
  if (workProducts.length === 0) return { ...context, outcome: "missing_evidence", evidence };
  if (!evidence.accepted) return { ...context, outcome: "invalid_or_unreadable_work_product", evidence };

  let reviewer: IssueReviewVerdictActor | null = null;
  if (reviewRequired) {
    const verdictActor = await resolveIssueReviewVerdictActor(db, child);
    if (!verdictActor) {
      return { ...context, outcome: "missing_independent_review", reason: "missing_reviewer" };
    }

    if (verdictActor.type === "agent" && verdictActor.id === child.assigneeAgentId) {
      return { ...context, outcome: "invalid_reviewer", reason: "executor_cannot_self_review" };
    }

    try {
      await assertIssueReviewVerdictActorAllowed(db, {
        issue: child,
        actor: verdictActor,
        reviewPolicy: "not_creator",
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        return { ...context, outcome: "invalid_reviewer", reason: "review_policy_denied" };
      }
      return {
        ...context,
        outcome: "missing_independent_review",
        reason: "unable_to_verify_review_authorization",
      };
    }
    reviewer = verdictActor;
  }

  return { ...context, outcome: "ready_for_jarvis_review", evidence, reviewer };
}
