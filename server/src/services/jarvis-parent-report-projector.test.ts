import { describe, expect, it } from "vitest";
import { projectJarvisParentReport, type JarvisParentReportCanonicalInput } from "./jarvis-parent-report-projector.js";

const input: JarvisParentReportCanonicalInput = {
  companyId: "00000000-0000-4000-8000-000000000001",
  jarvisAgentId: "00000000-0000-4000-8000-000000000002",
  parent: { id: "00000000-0000-4000-8000-000000000003", identifier: "NEX-1", assigneeAgentId: "00000000-0000-4000-8000-000000000002" },
  child: { id: "00000000-0000-4000-8000-000000000004", identifier: "NEX-2", parentId: "00000000-0000-4000-8000-000000000003", assigneeAgentId: "00000000-0000-4000-8000-000000000005" },
  acceptedPlan: { decompositionId: "decomposition-1", fingerprint: "plan-fp", childIssueIds: ["00000000-0000-4000-8000-000000000004"] },
  reconciliation: {
    outcome: "ready_for_jarvis_review",
    parentIssueId: "00000000-0000-4000-8000-000000000003",
    childIssueId: "00000000-0000-4000-8000-000000000004",
    childStatus: "done",
    executionState: null,
    approvalRequired: true,
    approvals: [{ id: "approval-1", status: "approved" }],
    evidence: { accepted: true, acceptedWorkProductIds: ["wp-1"], reasonCodes: ["registered_work_product_present"], problems: [] },
  },
  evidence: [{ id: "wp-1", type: "document", status: "ready", healthStatus: "healthy", url: "https://example.test/report", resourceRef: null, fingerprint: "evidence-fp" }],
  approvalStateFingerprint: "approval-fp",
  executionStateFingerprint: "execution-fp",
};

describe("projectJarvisParentReport", () => {
  it("projects only ready_for_jarvis_review", () => {
    expect(projectJarvisParentReport(input)).not.toBeNull();
    expect(projectJarvisParentReport({ ...input, reconciliation: { ...input.reconciliation, outcome: "child_not_terminal" } as never })).toBeNull();
  });

  it("includes every supplied canonical reference without inventing completion", () => {
    const report = projectJarvisParentReport(input)!;
    for (const reference of [input.parent.id, input.child.id, "decomposition-1", "plan-fp", "wp-1", "evidence-fp", "approval-1", "approval-fp", "execution-fp"]) {
      expect(report.body).toContain(reference);
    }
    expect(report.body).toContain("JARVIS는 parent 완료를 수행하지 않습니다");
    expect(report.body).not.toContain("Parent status: done");
  });

  it("is deterministic and creates a new revision when canonical state changes", () => {
    const first = projectJarvisParentReport(input)!;
    expect(projectJarvisParentReport(structuredClone(input))!.fingerprint).toBe(first.fingerprint);
    expect(projectJarvisParentReport({ ...input, executionStateFingerprint: "execution-fp-2" })!.fingerprint).not.toBe(first.fingerprint);
  });
});
