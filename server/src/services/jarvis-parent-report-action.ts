import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { issueApprovalService } from "./issue-approvals.js";
import { issueService } from "./issues.js";
import {
  reconcileDelegatedChildCompletion,
  type JarvisCompletionReconciliationResult,
} from "./jarvis-completion-reconciler.js";
import {
  projectJarvisParentReport,
  type JarvisParentReportCanonicalInput,
} from "./jarvis-parent-report-projector.js";
import { writeJarvisParentReport, type JarvisParentReportWriteResult } from "./jarvis-parent-report-writer.js";
import { workProductService } from "./work-products.js";

export type JarvisParentReportActionResult = {
  reconciliation: JarvisCompletionReconciliationResult;
  report: JarvisParentReportWriteResult | { outcome: "not_written" };
};

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

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function resourceRef(metadata: Record<string, unknown> | null): { kind: string; path?: string | null } | null {
  const raw = metadata?.resourceRef;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.kind !== "string" || !record.kind.trim()) return null;
  const path = typeof record.relativePath === "string"
    ? record.relativePath
    : typeof record.path === "string" ? record.path : null;
  return { kind: record.kind, path };
}

export async function runJarvisParentReportAction(
  db: Db,
  input: { companyId: string; parentIssueId: string; resolvedChildIssueId: string },
  actor: { agentId: string; runId?: string | null },
): Promise<JarvisParentReportActionResult> {
  const issueSvc = issueService(db);
  const [parent, child] = await Promise.all([
    issueSvc.getById(input.parentIssueId),
    issueSvc.getById(input.resolvedChildIssueId),
  ]);
  if (!parent || !child) throw new Error("issue_not_found");
  if (parent.companyId !== input.companyId || child.companyId !== input.companyId) throw new Error("company_mismatch");
  if (child.parentId !== parent.id) throw new Error("parent_mismatch");
  if (parent.assigneeAgentId !== actor.agentId) throw new Error("jarvis_assignment_mismatch");

  const reconciliation = await reconcileDelegatedChildCompletion(db, input);
  if (reconciliation.outcome !== "ready_for_jarvis_review") {
    return { reconciliation, report: { outcome: "not_written" } };
  }

  const [freshParent, freshChild, decompositions, products, approvals] = await Promise.all([
    issueSvc.getById(parent.id),
    issueSvc.getById(child.id),
    issueSvc.listAcceptedPlanDecompositions(parent.id),
    workProductService(db).listForIssue(child.id),
    issueApprovalService(db).listApprovalsForIssue(child.id),
  ]);
  if (!freshParent || !freshChild) throw new Error("issue_not_found");
  if (freshParent.companyId !== input.companyId || freshChild.companyId !== input.companyId) throw new Error("company_mismatch");
  if (freshChild.parentId !== freshParent.id) throw new Error("parent_mismatch");
  if (freshParent.assigneeAgentId !== actor.agentId) throw new Error("jarvis_assignment_mismatch");
  const acceptedPlan = decompositions.find((entry) => entry.childIssueIds.includes(freshChild.id));
  if (!acceptedPlan) throw new Error("child_not_in_accepted_plan");

  const evidence: JarvisParentReportCanonicalInput["evidence"] = products.map((product) => {
    const normalizedRef = resourceRef(product.metadata);
    return {
      id: product.id,
      type: product.type,
      status: product.status,
      healthStatus: product.healthStatus,
      url: product.url,
      resourceRef: normalizedRef,
      fingerprint: fingerprint({
        id: product.id,
        type: product.type,
        status: product.status,
        reviewState: product.reviewState,
        healthStatus: product.healthStatus,
        url: product.url,
        resourceRef: normalizedRef,
        updatedAt: product.updatedAt,
      }),
    };
  });
  const approvalState = approvals
    .map((approval) => ({ id: approval.id, status: approval.status, updatedAt: approval.updatedAt }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const canonical: JarvisParentReportCanonicalInput = {
    companyId: input.companyId,
    jarvisAgentId: actor.agentId,
    parent: {
      id: freshParent.id,
      identifier: freshParent.identifier ?? null,
      assigneeAgentId: freshParent.assigneeAgentId,
    },
    child: {
      id: freshChild.id,
      identifier: freshChild.identifier ?? null,
      parentId: freshChild.parentId,
      assigneeAgentId: freshChild.assigneeAgentId,
    },
    acceptedPlan: {
      decompositionId: acceptedPlan.id,
      fingerprint: acceptedPlan.requestFingerprint,
      childIssueIds: acceptedPlan.childIssueIds,
    },
    reconciliation,
    evidence,
    approvalStateFingerprint: fingerprint(approvalState),
    executionStateFingerprint: fingerprint(reconciliation.executionState),
  };
  const projection = projectJarvisParentReport(canonical);
  if (!projection) throw new Error("parent_report_projection_failed");
  const report = await writeJarvisParentReport(db, projection, actor);
  return { reconciliation, report };
}
