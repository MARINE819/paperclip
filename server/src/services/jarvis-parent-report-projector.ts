import { createHash } from "node:crypto";
import type { IssueCommentMetadata } from "@paperclipai/shared";
import type { JarvisCompletionReconciliationResult } from "./jarvis-completion-reconciler.js";

export const JARVIS_PARENT_REPORT_PROJECTION_VERSION = 2 as const;
export const JARVIS_PARENT_REPORT_FINGERPRINT_LABEL = "JARVIS parent report fingerprint";

export interface JarvisParentReportChildInput {
  id: string;
  identifier: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  reconciliation: JarvisCompletionReconciliationResult;
  evidence: Array<{
    id: string;
    type: string;
    status: string;
    healthStatus: string;
    url: string | null;
    resourceRef: { kind: string; path?: string | null } | null;
    fingerprint: string;
  }>;
}

export interface JarvisParentReportCanonicalInput {
  companyId: string;
  jarvisAgentId: string;
  parent: { id: string; identifier: string | null; assigneeAgentId: string | null };
  acceptedPlan: { decompositionId: string; fingerprint: string; childIssueIds: string[] };
  children: JarvisParentReportChildInput[];
  approvalStateFingerprint: string;
  executionStateFingerprint: string;
}

export interface JarvisParentReportProjection {
  fingerprint: string;
  body: string;
  metadata: IssueCommentMetadata;
  canonical: JarvisParentReportCanonicalInput;
}

type ReadyReconciliation = Extract<JarvisCompletionReconciliationResult, { outcome: "ready_for_jarvis_review" }>;
type ReadyChild = JarvisParentReportChildInput & { reconciliation: ReadyReconciliation };

function allChildrenReady(children: JarvisParentReportChildInput[]): ReadyChild[] | null {
  for (const child of children) {
    if (child.reconciliation.outcome !== "ready_for_jarvis_review") return null;
  }
  return children as ReadyChild[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function displayIssue(issue: { id: string; identifier: string | null }): string {
  return issue.identifier ? `${issue.identifier} (${issue.id})` : issue.id;
}

export function projectJarvisParentReport(
  input: JarvisParentReportCanonicalInput,
): JarvisParentReportProjection | null {
  const readyChildren = allChildrenReady(input.children);
  if (!readyChildren || readyChildren.length === 0) return null;

  // Sorted by child id so the projection (and its fingerprint) is identical
  // no matter which child in the decomposition was passed as the triggering
  // entry point -- a single canonical "Parent Report" per accepted plan.
  const children = [...readyChildren].sort((left, right) => left.id.localeCompare(right.id));

  const fingerprintSource = {
    version: JARVIS_PARENT_REPORT_PROJECTION_VERSION,
    companyId: input.companyId,
    parentIssueId: input.parent.id,
    parentAssigneeAgentId: input.parent.assigneeAgentId,
    acceptedPlanDecompositionId: input.acceptedPlan.decompositionId,
    acceptedPlanFingerprint: input.acceptedPlan.fingerprint,
    acceptedPlanChildIssueIds: [...input.acceptedPlan.childIssueIds].sort(),
    children: children.map((child) => {
      const acceptedEvidence = [...child.evidence]
        .filter((entry) => child.reconciliation.evidence.acceptedWorkProductIds.includes(entry.id))
        .sort((left, right) => left.id.localeCompare(right.id));
      return {
        id: child.id,
        parentId: child.parentId,
        assigneeAgentId: child.assigneeAgentId,
        outcome: child.reconciliation.outcome,
        childStatus: child.reconciliation.childStatus,
        reviewRequired: Boolean(child.reconciliation.reviewRequired),
        reviewer: child.reconciliation.reviewer ?? null,
        evidence: acceptedEvidence.map(({ id, fingerprint }) => ({ id, fingerprint })),
        evidenceAcceptance: child.reconciliation.evidence,
        approvals: [...child.reconciliation.approvals].sort((left, right) => left.id.localeCompare(right.id)),
      };
    }),
    approvalStateFingerprint: input.approvalStateFingerprint,
    executionStateFingerprint: input.executionStateFingerprint,
  };
  const fingerprint = `v${JARVIS_PARENT_REPORT_PROJECTION_VERSION}:sha256:${createHash("sha256")
    .update(stableJson(fingerprintSource), "utf8")
    .digest("hex")}`;

  const childSections = children.map((child, index) => {
    const acceptedEvidence = [...child.evidence]
      .filter((entry) => child.reconciliation.evidence.acceptedWorkProductIds.includes(entry.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const evidenceLines = acceptedEvidence.map((entry) => {
      const location = entry.url ?? (entry.resourceRef?.path ? `${entry.resourceRef.kind}:${entry.resourceRef.path}` : entry.resourceRef?.kind ?? "none");
      return `- ${entry.id} | type=${entry.type} | status=${entry.status} | health=${entry.healthStatus} | location=${location} | fingerprint=${entry.fingerprint}`;
    });
    const approvalLines = child.reconciliation.approvals.length
      ? child.reconciliation.approvals.map((approval) => `- ${approval.id}: ${approval.status}`)
      : ["- 연결된 Approval 없음 (현재 canonical execution state에서 필수 아님)"];
    const reviewLine = child.reconciliation.reviewRequired
      ? `- Independent review: PASS (reviewer: ${child.reconciliation.reviewer ? `${child.reconciliation.reviewer.type} ${child.reconciliation.reviewer.id}` : "unknown"}; policy: not_creator)`
      : "- Independent review: not required";
    return [
      `### Child ${index + 1}: ${displayIssue(child)}`,
      "",
      `- Assignee: ${child.assigneeAgentId ?? "unassigned"}`,
      `- Reconciliation outcome: ${child.reconciliation.outcome}`,
      `- Child status: ${child.reconciliation.childStatus}`,
      reviewLine,
      "",
      "#### Canonical evidence",
      ...evidenceLines,
      "",
      "#### Canonical approvals",
      ...approvalLines,
    ].join("\n");
  });

  const body = [
    "## JARVIS 부모 통합 보고서",
    "",
    `- Parent Issue: ${displayIssue(input.parent)}`,
    `- Accepted plan: ${input.acceptedPlan.decompositionId} / ${input.acceptedPlan.fingerprint}`,
    `- Children: ${children.length}개 (전원 ready_for_jarvis_review)`,
    `- Execution state fingerprint: ${input.executionStateFingerprint}`,
    `- Approval state fingerprint: ${input.approvalStateFingerprint}`,
    "",
    ...childSections.flatMap((section) => [section, ""]),
    "### 권고",
    "Canonical 자료는 Human Board 검토 준비 상태입니다. JARVIS는 parent 완료를 수행하지 않습니다. Human Board가 기존 canonical PATCH 경로에서 최종 완료 여부를 별도로 결정해야 합니다.",
    "",
    `<!-- jarvis-parent-report:${fingerprint} -->`,
  ].join("\n");

  const rows: IssueCommentMetadata["sections"][number]["rows"] = [
    { type: "key_value", label: JARVIS_PARENT_REPORT_FINGERPRINT_LABEL, value: fingerprint },
    { type: "issue_link", label: "Parent Issue", issueId: input.parent.id, identifier: input.parent.identifier },
    { type: "agent_link", label: "JARVIS", agentId: input.jarvisAgentId },
  ];
  for (const child of children) {
    rows.push({ type: "issue_link", label: "Child Issue", issueId: child.id, identifier: child.identifier });
    const reviewer = child.reconciliation.reviewer;
    if (reviewer?.type === "agent") {
      rows.push({ type: "agent_link", label: "Independent Reviewer", agentId: reviewer.id });
    } else if (reviewer?.type === "user") {
      rows.push({ type: "key_value", label: "Independent Reviewer", value: `user:${reviewer.id}` });
    }
  }
  const metadata: IssueCommentMetadata = {
    version: 1,
    sections: [{ title: "JARVIS parent report", rows }],
  };
  return { fingerprint, body, metadata, canonical: input };
}
