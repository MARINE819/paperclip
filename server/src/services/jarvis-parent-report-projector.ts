import { createHash } from "node:crypto";
import type { IssueCommentMetadata } from "@paperclipai/shared";
import type { JarvisCompletionReconciliationResult } from "./jarvis-completion-reconciler.js";

export const JARVIS_PARENT_REPORT_PROJECTION_VERSION = 1 as const;
export const JARVIS_PARENT_REPORT_FINGERPRINT_LABEL = "JARVIS parent report fingerprint";

export interface JarvisParentReportCanonicalInput {
  companyId: string;
  jarvisAgentId: string;
  parent: { id: string; identifier: string | null; assigneeAgentId: string | null };
  child: { id: string; identifier: string | null; parentId: string | null; assigneeAgentId: string | null };
  acceptedPlan: { decompositionId: string; fingerprint: string; childIssueIds: string[] };
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
  approvalStateFingerprint: string;
  executionStateFingerprint: string;
}

export interface JarvisParentReportProjection {
  fingerprint: string;
  body: string;
  metadata: IssueCommentMetadata;
  canonical: JarvisParentReportCanonicalInput;
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
  if (input.reconciliation.outcome !== "ready_for_jarvis_review") return null;
  const reconciliation = input.reconciliation;

  const acceptedEvidence = input.evidence
    .filter((entry) => reconciliation.evidence.acceptedWorkProductIds.includes(entry.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const fingerprintSource = {
    version: JARVIS_PARENT_REPORT_PROJECTION_VERSION,
    companyId: input.companyId,
    parentIssueId: input.parent.id,
    parentAssigneeAgentId: input.parent.assigneeAgentId,
    childIssueId: input.child.id,
    childParentIssueId: input.child.parentId,
    childAssigneeAgentId: input.child.assigneeAgentId,
    acceptedPlanDecompositionId: input.acceptedPlan.decompositionId,
    acceptedPlanFingerprint: input.acceptedPlan.fingerprint,
    acceptedPlanChildIssueIds: [...input.acceptedPlan.childIssueIds].sort(),
    outcome: reconciliation.outcome,
    childStatus: reconciliation.childStatus,
    evidence: acceptedEvidence.map(({ id, fingerprint }) => ({ id, fingerprint })),
    evidenceAcceptance: reconciliation.evidence,
    approvals: [...reconciliation.approvals].sort((a, b) => a.id.localeCompare(b.id)),
    approvalStateFingerprint: input.approvalStateFingerprint,
    executionStateFingerprint: input.executionStateFingerprint,
  };
  const fingerprint = `v${JARVIS_PARENT_REPORT_PROJECTION_VERSION}:sha256:${createHash("sha256")
    .update(stableJson(fingerprintSource), "utf8")
    .digest("hex")}`;
  const evidenceLines = acceptedEvidence.map((entry) => {
    const location = entry.url ?? (entry.resourceRef?.path ? `${entry.resourceRef.kind}:${entry.resourceRef.path}` : entry.resourceRef?.kind ?? "none");
    return `- ${entry.id} | type=${entry.type} | status=${entry.status} | health=${entry.healthStatus} | location=${location} | fingerprint=${entry.fingerprint}`;
  });
  const approvalLines = input.reconciliation.approvals.length
    ? input.reconciliation.approvals.map((approval) => `- ${approval.id}: ${approval.status}`)
    : ["- 연결된 Approval 없음 (현재 canonical execution state에서 필수 아님)"];
  const body = [
    "## JARVIS 부모 통합 보고서",
    "",
    `- Parent Issue: ${displayIssue(input.parent)}`,
    `- Child Issue: ${displayIssue(input.child)}`,
    `- Child assignee: ${input.child.assigneeAgentId ?? "unassigned"}`,
    `- Accepted plan: ${input.acceptedPlan.decompositionId} / ${input.acceptedPlan.fingerprint}`,
    `- Reconciliation outcome: ${input.reconciliation.outcome}`,
    `- Child status: ${input.reconciliation.childStatus}`,
    `- Execution state fingerprint: ${input.executionStateFingerprint}`,
    `- Approval state fingerprint: ${input.approvalStateFingerprint}`,
    "",
    "### Canonical evidence",
    ...evidenceLines,
    "",
    "### Canonical approvals",
    ...approvalLines,
    "",
    "### 권고",
    "Canonical 자료는 Human Board 검토 준비 상태입니다. JARVIS는 parent 완료를 수행하지 않습니다. Human Board가 기존 canonical PATCH 경로에서 최종 완료 여부를 별도로 결정해야 합니다.",
    "",
    `<!-- jarvis-parent-report:${fingerprint} -->`,
  ].join("\n");
  const metadata: IssueCommentMetadata = {
    version: 1,
    sections: [{
      title: "JARVIS parent report",
      rows: [
        { type: "key_value", label: JARVIS_PARENT_REPORT_FINGERPRINT_LABEL, value: fingerprint },
        { type: "issue_link", label: "Parent Issue", issueId: input.parent.id, identifier: input.parent.identifier },
        { type: "issue_link", label: "Child Issue", issueId: input.child.id, identifier: input.child.identifier },
        { type: "agent_link", label: "JARVIS", agentId: input.jarvisAgentId },
      ],
    }],
  };
  return { fingerprint, body, metadata, canonical: input };
}
