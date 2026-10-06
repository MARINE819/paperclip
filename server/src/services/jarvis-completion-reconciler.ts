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
  | (ReconciliationContext & { outcome: "siblings_not_ready"; notReadySiblingIds: string[] })
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

// Evaluates ONE child issue's own readiness against the exact same rules
// M2-QA-LANE already verified: terminal status, linked-approval state,
// changes-requested, Evidence Acceptance, and (when required) an
// independently-verified reviewer. Parametrized on `child`/`parentIssueId`
// so reconcileDelegatedChildCompletion can call this once for the primary
// child (preserving its exact historical single-child behavior/shape) and
// reuse it unchanged for each sibling in a multi-child decomposition --
// never a second, divergent copy of these rules.
async function evaluateChildReadiness(
  db: Db,
  parentIssueId: string,
  child: Awaited<ReturnType<ReturnType<typeof issueService>["getById"]>> & { id: string },
  reviewRequiredOverride: boolean | undefined,
): Promise<JarvisCompletionReconciliationResult> {
  const reviewRequired = child.reviewPolicy === "not_creator" || Boolean(reviewRequiredOverride);
  const executionState = parseIssueExecutionState(child.executionState);
  const approvalRequired = executionState?.status === "pending" && executionState.currentParticipant?.type === "user";
  const linkedApprovals = await issueApprovalService(db).listApprovalsForIssue(child.id);
  const approvals = linkedApprovals.map(({ id, status }) => ({ id, status }));
  const context: ReconciliationContext = {
    parentIssueId,
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
  const matchedDecomposition = decompositions.find((entry) => entry.childIssueIds.includes(child.id));
  if (!matchedDecomposition) {
    return { outcome: "invalid_company_or_issue_relationship", reason: "child_not_in_accepted_plan" };
  }

  const primaryResult = await evaluateChildReadiness(db, parent.id, child, input.reviewRequired);
  if (primaryResult.outcome !== "ready_for_jarvis_review") return primaryResult;

  // Multi-child-safe: a decomposition with more than one child must have
  // EVERY sibling independently ready (its own terminal status, approvals,
  // changes-requested, evidence, and -- when its own reviewPolicy requires
  // it -- an independently-verified reviewer) before the primary's own
  // readiness can be trusted as the parent's readiness. A sibling's
  // reviewRequired is always its OWN reviewPolicy's call, never the
  // primary's caller-supplied override. Today's only reachable case
  // (assertSingleSpecialistPlan still limits submitToJarvis to one child)
  // has zero siblings, so this loop never runs and behavior is unchanged.
  const siblingIds = matchedDecomposition.childIssueIds.filter((id) => id !== child.id);
  if (siblingIds.length > 0) {
    const notReadySiblingIds: string[] = [];
    for (const siblingId of siblingIds) {
      const sibling = await issues.getById(siblingId);
      if (!sibling || sibling.companyId !== input.companyId) {
        notReadySiblingIds.push(siblingId);
        continue;
      }
      const siblingResult = await evaluateChildReadiness(db, parent.id, sibling, undefined);
      if (siblingResult.outcome !== "ready_for_jarvis_review") {
        notReadySiblingIds.push(siblingId);
      }
    }
    if (notReadySiblingIds.length > 0) {
      return { ...primaryResult, outcome: "siblings_not_ready", notReadySiblingIds };
    }
  }

  return primaryResult;
}
