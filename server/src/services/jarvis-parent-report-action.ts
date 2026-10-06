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
  type JarvisParentReportChildInput,
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
  const path = typeof record.relativePath === "string" && record.relativePath.trim().length > 0
    ? record.relativePath.trim()
    : typeof record.path === "string" && record.path.trim().length > 0
    ? record.path.trim()
    : typeof record.displayPath === "string" && record.displayPath.trim().length > 0
    ? record.displayPath.trim()
    : null;
  return { kind: record.kind.trim(), path };
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

  const decompositions = await issueSvc.listAcceptedPlanDecompositions(parent.id);
  const matchedDecomposition = decompositions.find((entry) => entry.childIssueIds.includes(child.id));
  if (!matchedDecomposition) throw new Error("child_not_in_accepted_plan");

  // Entry-point independence: resolve the *entire* decomposition's children
  // (not just the one that triggered this call) so JARVIS gets the same
  // single aggregated report no matter which ready child it reports on.
  // Every other child is reconciled through the exact same, unmodified
  // reconcileDelegatedChildCompletion (jarvis-completion-reconciler.ts) --
  // never a second, divergent readiness rule.
  const childIssueIds = matchedDecomposition.childIssueIds;
  const perChildReconciliation = await Promise.all(
    childIssueIds.map((id) =>
      id === child.id
        ? Promise.resolve(reconciliation)
        : reconcileDelegatedChildCompletion(db, {
            companyId: input.companyId,
            parentIssueId: parent.id,
            resolvedChildIssueId: id,
          }),
    ),
  );
  if (perChildReconciliation.some((result) => result.outcome !== "ready_for_jarvis_review")) {
    return { reconciliation, report: { outcome: "not_written" } };
  }

  const [freshParent, ...childDetails] = await Promise.all([
    issueSvc.getById(parent.id),
    ...childIssueIds.map(async (id, index): Promise<JarvisParentReportChildInput> => {
      const [freshChild, products] = await Promise.all([
        issueSvc.getById(id),
        workProductService(db).listForIssue(id),
      ]);
      if (!freshChild) throw new Error("issue_not_found");
      if (freshChild.companyId !== input.companyId) throw new Error("company_mismatch");
      if (freshChild.parentId !== parent.id) throw new Error("parent_mismatch");
      const evidence = products.map((product) => {
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
      return {
        id: freshChild.id,
        identifier: freshChild.identifier ?? null,
        parentId: freshChild.parentId,
        assigneeAgentId: freshChild.assigneeAgentId,
        reconciliation: perChildReconciliation[index],
        evidence,
      };
    }),
  ]);
  if (!freshParent) throw new Error("issue_not_found");
  if (freshParent.companyId !== input.companyId) throw new Error("company_mismatch");
  if (freshParent.assigneeAgentId !== actor.agentId) throw new Error("jarvis_assignment_mismatch");

  const approvalFingerprints = await Promise.all(
    childIssueIds.map(async (id) => {
      const approvals = await issueApprovalService(db).listApprovalsForIssue(id);
      return {
        childId: id,
        approvals: approvals
          .map((approval) => ({ id: approval.id, status: approval.status, updatedAt: approval.updatedAt }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      };
    }),
  );
  const approvalStateFingerprint = fingerprint(
    [...approvalFingerprints].sort((left, right) => left.childId.localeCompare(right.childId)),
  );
  const executionStateFingerprint = fingerprint(
    [...childDetails]
      .map((entry) => ({
        childId: entry.id,
        executionState: entry.reconciliation.outcome === "ready_for_jarvis_review" ? entry.reconciliation.executionState : null,
      }))
      .sort((left, right) => left.childId.localeCompare(right.childId)),
  );

  const canonical: JarvisParentReportCanonicalInput = {
    companyId: input.companyId,
    jarvisAgentId: actor.agentId,
    parent: {
      id: freshParent.id,
      identifier: freshParent.identifier ?? null,
      assigneeAgentId: freshParent.assigneeAgentId,
    },
    acceptedPlan: {
      decompositionId: matchedDecomposition.id,
      fingerprint: matchedDecomposition.requestFingerprint,
      childIssueIds: matchedDecomposition.childIssueIds,
    },
    children: childDetails,
    approvalStateFingerprint,
    executionStateFingerprint,
  };
  const projection = projectJarvisParentReport(canonical);
  if (!projection) throw new Error("parent_report_projection_failed");
  const report = await writeJarvisParentReport(db, projection, actor);
  return { reconciliation, report };
}
