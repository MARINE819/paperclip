import type { Db } from "@paperclipai/db";
import { issueApprovalService } from "./issue-approvals.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
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
  approvals: ApprovalSummary[];
}

export type JarvisCompletionReconciliationResult =
  | (ReconciliationContext & { outcome: "ready_for_jarvis_review"; evidence: JarvisEvidenceAcceptanceResult })
  | (ReconciliationContext & { outcome: "child_not_terminal" })
  | (ReconciliationContext & { outcome: "missing_evidence"; evidence: JarvisEvidenceAcceptanceResult })
  | (ReconciliationContext & { outcome: "invalid_or_unreadable_work_product"; evidence: JarvisEvidenceAcceptanceResult })
  | (ReconciliationContext & { outcome: "pending_human_approval"; approvalId: string })
  | (ReconciliationContext & { outcome: "revision_required"; approvalId: string })
  | (ReconciliationContext & { outcome: "approval_rejected"; approvalId: string })
  | (ReconciliationContext & { outcome: "missing_required_approval" })
  | { outcome: "invalid_company_or_issue_relationship"; reason: "issue_not_found" | "company_mismatch" | "parent_mismatch" | "child_not_in_accepted_plan" };

export async function reconcileDelegatedChildCompletion(
  db: Db,
  input: { companyId: string; parentIssueId: string; resolvedChildIssueId: string },
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
    approvals,
  };

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

  const workProducts = await workProductService(db).listForIssue(child.id);
  const evidence = evaluateEvidenceAcceptance({ childIssueId: child.id, workProducts });
  if (workProducts.length === 0) return { ...context, outcome: "missing_evidence", evidence };
  if (!evidence.accepted) return { ...context, outcome: "invalid_or_unreadable_work_product", evidence };
  return { ...context, outcome: "ready_for_jarvis_review", evidence };
}
