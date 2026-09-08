import { beforeEach, describe, expect, it, vi } from "vitest";
import { runJarvisParentReportAction } from "./jarvis-parent-report-action.js";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  listAcceptedPlanDecompositions: vi.fn(),
  listForIssue: vi.fn(),
  listApprovalsForIssue: vi.fn(),
  reconcile: vi.fn(),
  project: vi.fn(),
  write: vi.fn(),
}));

vi.mock("./issues.js", () => ({ issueService: () => ({
  getById: mocks.getById,
  listAcceptedPlanDecompositions: mocks.listAcceptedPlanDecompositions,
}) }));
vi.mock("./work-products.js", () => ({ workProductService: () => ({ listForIssue: mocks.listForIssue }) }));
vi.mock("./issue-approvals.js", () => ({ issueApprovalService: () => ({ listApprovalsForIssue: mocks.listApprovalsForIssue }) }));
vi.mock("./jarvis-completion-reconciler.js", () => ({ reconcileDelegatedChildCompletion: mocks.reconcile }));
vi.mock("./jarvis-parent-report-projector.js", () => ({ projectJarvisParentReport: mocks.project }));
vi.mock("./jarvis-parent-report-writer.js", () => ({ writeJarvisParentReport: mocks.write }));

const companyId = "00000000-0000-4000-8000-000000000001";
const jarvisId = "00000000-0000-4000-8000-000000000002";
const parentId = "00000000-0000-4000-8000-000000000003";
const childId = "00000000-0000-4000-8000-000000000004";
const specialistId = "00000000-0000-4000-8000-000000000005";
const parent = { id: parentId, identifier: "NEX-1", companyId, parentId: null, assigneeAgentId: jarvisId };
const child = { id: childId, identifier: "NEX-2", companyId, parentId, assigneeAgentId: specialistId, executionState: null };
const ready = {
  outcome: "ready_for_jarvis_review",
  parentIssueId: parentId,
  childIssueId: childId,
  childStatus: "done",
  executionState: null,
  approvalRequired: false,
  approvals: [],
  evidence: { accepted: true, acceptedWorkProductIds: ["wp-1"], reasonCodes: [], problems: [] },
};

describe("runJarvisParentReportAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getById.mockImplementation(async (id: string) => id === parentId ? parent : id === childId ? child : null);
    mocks.listAcceptedPlanDecompositions.mockResolvedValue([{ id: "d-1", requestFingerprint: "plan-fp", childIssueIds: [childId] }]);
    mocks.listForIssue.mockResolvedValue([{ id: "wp-1", type: "document", status: "ready", reviewState: "accepted", healthStatus: "healthy", url: "https://example.test", metadata: null, updatedAt: new Date("2026-01-01") }]);
    mocks.listApprovalsForIssue.mockResolvedValue([]);
    mocks.reconcile.mockResolvedValue(ready);
    mocks.project.mockReturnValue({ fingerprint: "fp", canonical: {}, body: "report", metadata: {} });
    mocks.write.mockResolvedValue({ outcome: "created", fingerprint: "fp", commentId: "comment-1" });
  });

  it("re-reads canonical state and writes a ready report", async () => {
    const result = await runJarvisParentReportAction({} as never, { companyId, parentIssueId: parentId, resolvedChildIssueId: childId }, { agentId: jarvisId, runId: "run-1" });
    expect(result.report.outcome).toBe("created");
    expect(mocks.getById).toHaveBeenCalledTimes(4);
    expect(mocks.project).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("returns not_written with zero projector/writer calls for non-ready outcomes", async () => {
    mocks.reconcile.mockResolvedValue({ ...ready, outcome: "child_not_terminal" });
    const result = await runJarvisParentReportAction({} as never, { companyId, parentIssueId: parentId, resolvedChildIssueId: childId }, { agentId: jarvisId });
    expect(result.report).toEqual({ outcome: "not_written" });
    expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("rejects assignment and parent relationship mismatches before mutation", async () => {
    mocks.getById.mockImplementation(async (id: string) => id === parentId ? { ...parent, assigneeAgentId: "other" } : child);
    await expect(runJarvisParentReportAction({} as never, { companyId, parentIssueId: parentId, resolvedChildIssueId: childId }, { agentId: jarvisId })).rejects.toThrow("jarvis_assignment_mismatch");
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
