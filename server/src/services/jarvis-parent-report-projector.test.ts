import { describe, expect, it } from "vitest";
import {
  projectJarvisParentReport,
  type JarvisParentReportCanonicalInput,
  type JarvisParentReportChildInput,
} from "./jarvis-parent-report-projector.js";

const parentId = "00000000-0000-4000-8000-000000000003";
const childId = "00000000-0000-4000-8000-000000000004";
const childId2 = "00000000-0000-4000-8000-000000000006";
const specialistId = "00000000-0000-4000-8000-000000000005";
const specialistId2 = "00000000-0000-4000-8000-000000000007";

const readyReconciliation = {
  outcome: "ready_for_jarvis_review" as const,
  parentIssueId: parentId,
  childIssueId: childId,
  childStatus: "done",
  executionState: null,
  approvalRequired: true,
  approvals: [{ id: "approval-1", status: "approved" }],
  evidence: { accepted: true, acceptedWorkProductIds: ["wp-1"], reasonCodes: ["registered_work_product_present"], problems: [] },
};

const childInput: JarvisParentReportChildInput = {
  id: childId,
  identifier: "NEX-2",
  parentId,
  assigneeAgentId: specialistId,
  reconciliation: readyReconciliation,
  evidence: [{ id: "wp-1", type: "document", status: "ready", healthStatus: "healthy", url: "https://example.test/report", resourceRef: null, fingerprint: "evidence-fp" }],
};

const input: JarvisParentReportCanonicalInput = {
  companyId: "00000000-0000-4000-8000-000000000001",
  jarvisAgentId: "00000000-0000-4000-8000-000000000002",
  parent: { id: parentId, identifier: "NEX-1", assigneeAgentId: "00000000-0000-4000-8000-000000000002" },
  acceptedPlan: { decompositionId: "decomposition-1", fingerprint: "plan-fp", childIssueIds: [childId] },
  children: [childInput],
  approvalStateFingerprint: "approval-fp",
  executionStateFingerprint: "execution-fp",
};

describe("projectJarvisParentReport", () => {
  it("projects only when every child is ready_for_jarvis_review", () => {
    expect(projectJarvisParentReport(input)).not.toBeNull();
    expect(
      projectJarvisParentReport({
        ...input,
        children: [{ ...childInput, reconciliation: { ...readyReconciliation, outcome: "child_not_terminal" } as never }],
      }),
    ).toBeNull();
  });

  it("returns null when there are zero children", () => {
    expect(projectJarvisParentReport({ ...input, children: [] })).toBeNull();
  });

  it("includes every supplied canonical reference without inventing completion", () => {
    const report = projectJarvisParentReport(input)!;
    for (const reference of [input.parent.id, childId, "decomposition-1", "plan-fp", "wp-1", "evidence-fp", "approval-1", "approval-fp", "execution-fp"]) {
      expect(report.body).toContain(reference);
    }
    expect(report.body).toContain("JARVIS는 parent 완료를 수행하지 않습니다");
    expect(report.body).not.toContain("Parent status: done");
    expect(report.body).toContain("- Independent review: not required");
    expect(report.metadata.sections[0].rows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Independent Reviewer" })]),
    );
  });

  it("is deterministic and creates a new revision when canonical state changes", () => {
    const first = projectJarvisParentReport(input)!;
    expect(projectJarvisParentReport(structuredClone(input))!.fingerprint).toBe(first.fingerprint);
    expect(projectJarvisParentReport({ ...input, executionStateFingerprint: "execution-fp-2" })!.fingerprint).not.toBe(first.fingerprint);
    expect(
      projectJarvisParentReport({
        ...input,
        children: [{
          ...childInput,
          reconciliation: {
            ...readyReconciliation,
            reviewRequired: true,
            reviewer: { type: "agent", id: "00000000-0000-4000-8000-000000000009" },
          },
        }],
      })!.fingerprint,
    ).not.toBe(first.fingerprint);
  });

  it("is independent of which child in the decomposition is listed first (entry-point independence)", () => {
    const secondChild: JarvisParentReportChildInput = {
      id: childId2,
      identifier: "NEX-3",
      parentId,
      assigneeAgentId: specialistId2,
      reconciliation: { ...readyReconciliation, childIssueId: childId2, approvals: [{ id: "approval-2", status: "approved" }] },
      evidence: [{ id: "wp-2", type: "document", status: "ready", healthStatus: "healthy", url: "https://example.test/second", resourceRef: null, fingerprint: "evidence-fp-2" }],
    };
    const forward = projectJarvisParentReport({
      ...input,
      acceptedPlan: { ...input.acceptedPlan, childIssueIds: [childId, childId2] },
      children: [childInput, secondChild],
    })!;
    const reversed = projectJarvisParentReport({
      ...input,
      acceptedPlan: { ...input.acceptedPlan, childIssueIds: [childId2, childId] },
      children: [secondChild, childInput],
    })!;
    expect(reversed.fingerprint).toBe(forward.fingerprint);
  });

  it("aggregates every child's evidence, reviewer and approvals in a multi-child decomposition", () => {
    const secondChild: JarvisParentReportChildInput = {
      id: childId2,
      identifier: "NEX-3",
      parentId,
      assigneeAgentId: specialistId2,
      reconciliation: {
        ...readyReconciliation,
        childIssueId: childId2,
        reviewRequired: true,
        reviewer: { type: "agent", id: "00000000-0000-4000-8000-000000000009" },
        approvals: [{ id: "approval-2", status: "approved" }],
        evidence: { ...readyReconciliation.evidence, acceptedWorkProductIds: ["wp-2"] },
      },
      evidence: [{ id: "wp-2", type: "document", status: "ready", healthStatus: "healthy", url: "https://example.test/second", resourceRef: null, fingerprint: "evidence-fp-2" }],
    };
    const report = projectJarvisParentReport({
      ...input,
      acceptedPlan: { ...input.acceptedPlan, childIssueIds: [childId, childId2] },
      children: [childInput, secondChild],
    })!;
    for (const reference of [childId, childId2, "wp-1", "wp-2", "evidence-fp", "evidence-fp-2", "approval-1", "approval-2"]) {
      expect(report.body).toContain(reference);
    }
    expect(report.body).toContain("- Independent review: not required");
    expect(report.body).toContain(
      "- Independent review: PASS (reviewer: agent 00000000-0000-4000-8000-000000000009; policy: not_creator)",
    );
    expect(report.metadata.sections[0].rows).toEqual(
      expect.arrayContaining([
        { type: "issue_link", label: "Child Issue", issueId: childId, identifier: "NEX-2" },
        { type: "issue_link", label: "Child Issue", issueId: childId2, identifier: "NEX-3" },
        { type: "agent_link", label: "Independent Reviewer", agentId: "00000000-0000-4000-8000-000000000009" },
      ]),
    );
  });

  it("does not project when any one child is not yet ready (no partial completion hidden as success)", () => {
    const notReadyChild: JarvisParentReportChildInput = {
      id: childId2,
      identifier: "NEX-3",
      parentId,
      assigneeAgentId: specialistId2,
      reconciliation: { ...readyReconciliation, childIssueId: childId2, outcome: "revision_required", reason: "changes_requested" } as never,
      evidence: [],
    };
    expect(
      projectJarvisParentReport({
        ...input,
        acceptedPlan: { ...input.acceptedPlan, childIssueIds: [childId, childId2] },
        children: [childInput, notReadyChild],
      }),
    ).toBeNull();
  });

  it("projects independent reviewer into body and metadata when review is required", () => {
    const reviewerInput: JarvisParentReportCanonicalInput = {
      ...input,
      children: [{
        ...childInput,
        reconciliation: {
          ...readyReconciliation,
          reviewRequired: true,
          reviewer: { type: "agent", id: "00000000-0000-4000-8000-000000000009" },
        },
      }],
    };
    const report = projectJarvisParentReport(reviewerInput)!;
    expect(report.body).toContain(
      "- Independent review: PASS (reviewer: agent 00000000-0000-4000-8000-000000000009; policy: not_creator)",
    );
    expect(report.metadata.sections[0].rows).toEqual(
      expect.arrayContaining([
        {
          type: "agent_link",
          label: "Independent Reviewer",
          agentId: "00000000-0000-4000-8000-000000000009",
        },
      ]),
    );
  });

  it("projects human reviewer as key_value in metadata when review verdict actor is user", () => {
    const reviewerInput: JarvisParentReportCanonicalInput = {
      ...input,
      children: [{
        ...childInput,
        reconciliation: {
          ...readyReconciliation,
          reviewRequired: true,
          reviewer: { type: "user", id: "user-123" },
        },
      }],
    };
    const report = projectJarvisParentReport(reviewerInput)!;
    expect(report.body).toContain(
      "- Independent review: PASS (reviewer: user user-123; policy: not_creator)",
    );
    expect(report.metadata.sections[0].rows).toEqual(
      expect.arrayContaining([
        {
          type: "key_value",
          label: "Independent Reviewer",
          value: "user:user-123",
        },
      ]),
    );
  });
});
