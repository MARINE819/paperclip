import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileDelegatedChildCompletion } from "./jarvis-completion-reconciler.js";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  listAcceptedPlanDecompositions: vi.fn(),
  listApprovalsForIssue: vi.fn(),
  listForIssue: vi.fn(),
}));

vi.mock("./issues.js", () => ({ issueService: () => ({ getById: mocks.getById, listAcceptedPlanDecompositions: mocks.listAcceptedPlanDecompositions }) }));
vi.mock("./issue-approvals.js", () => ({ issueApprovalService: () => ({ listApprovalsForIssue: mocks.listApprovalsForIssue }) }));
vi.mock("./work-products.js", () => ({ workProductService: () => ({ listForIssue: mocks.listForIssue }) }));

const parent = { id: "parent", companyId: "company", assigneeAgentId: "jarvis" };
const child = { id: "child", companyId: "company", parentId: "parent", status: "done", executionState: null };
const evidence = { id: "wp", issueId: "child", type: "document", status: "ready", healthStatus: "healthy", reviewState: "unreviewed", url: "https://example.test/report", metadata: null };
const pendingHumanState = {
  status: "pending", currentStageId: "00000000-0000-4000-8000-000000000001", currentStageIndex: 0, currentStageType: "approval",
  currentParticipant: { type: "user", userId: "board", agentId: null }, returnAssignee: null,
  reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
  monitor: null, changesRequestedCount: 0,
};

describe("reconcileDelegatedChildCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : child);
    mocks.listAcceptedPlanDecompositions.mockResolvedValue([{ childIssueIds: ["child"] }]);
    mocks.listApprovalsForIssue.mockResolvedValue([]);
    mocks.listForIssue.mockResolvedValue([evidence]);
  });

  const reconcile = () => reconcileDelegatedChildCompletion({} as never, { companyId: "company", parentIssueId: "parent", resolvedChildIssueId: "child" });

  it("requires the canonical child to be done", async () => {
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : { ...child, status: "in_review" });
    expect(await reconcile()).toMatchObject({ outcome: "child_not_terminal", childStatus: "in_review" });
  });

  it("returns ready with acceptable evidence when no approval is required", async () => {
    expect(await reconcile()).toMatchObject({ outcome: "ready_for_jarvis_review", approvalRequired: false });
  });

  it("distinguishes missing from invalid evidence", async () => {
    mocks.listForIssue.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...evidence, url: null }]);
    expect(await reconcile()).toMatchObject({ outcome: "missing_evidence" });
    expect(await reconcile()).toMatchObject({ outcome: "invalid_or_unreadable_work_product" });
  });

  it.each([
    ["pending", "pending_human_approval"],
    ["revision_requested", "revision_required"],
    ["rejected", "approval_rejected"],
  ])("maps linked %s approval separately", async (status, outcome) => {
    mocks.listApprovalsForIssue.mockResolvedValue([{ id: "approval", status }]);
    expect(await reconcile()).toMatchObject({ outcome, approvalId: "approval" });
  });

  it("fails closed when execution requires Human approval but no linked approval exists", async () => {
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : { ...child, executionState: pendingHumanState });
    expect(await reconcile()).toMatchObject({ outcome: "missing_required_approval", approvalRequired: true, executionState: pendingHumanState });
  });

  it("treats approved linked approval as satisfied", async () => {
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : { ...child, executionState: pendingHumanState });
    mocks.listApprovalsForIssue.mockResolvedValue([{ id: "approval", status: "approved" }]);
    expect(await reconcile()).toMatchObject({ outcome: "ready_for_jarvis_review", approvalRequired: true });
  });

  it.each([
    [{ ...child, companyId: "other" }, "company_mismatch"],
    [{ ...child, parentId: "other" }, "parent_mismatch"],
  ])("rejects invalid company or parent relationship", async (badChild, reason) => {
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : badChild);
    expect(await reconcile()).toEqual({ outcome: "invalid_company_or_issue_relationship", reason });
  });

  it("rejects a child absent from the accepted decomposition", async () => {
    mocks.listAcceptedPlanDecompositions.mockResolvedValue([]);
    expect(await reconcile()).toEqual({ outcome: "invalid_company_or_issue_relationship", reason: "child_not_in_accepted_plan" });
  });

  it("is repeatable and performs no mutations", async () => {
    expect(await reconcile()).toEqual(await reconcile());
    expect(mocks.listApprovalsForIssue).toHaveBeenCalledWith("child");
  });
});
