import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { reconcileDelegatedChildCompletion } from "./jarvis-completion-reconciler.js";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  listAcceptedPlanDecompositions: vi.fn(),
  listApprovalsForIssue: vi.fn(),
  listForIssue: vi.fn(),
  assertIssueReviewVerdictActorAllowed: vi.fn(),
}));

vi.mock("./issues.js", () => ({ issueService: () => ({ getById: mocks.getById, listAcceptedPlanDecompositions: mocks.listAcceptedPlanDecompositions }) }));
vi.mock("./issue-approvals.js", () => ({ issueApprovalService: () => ({ listApprovalsForIssue: mocks.listApprovalsForIssue }) }));
vi.mock("./work-products.js", () => ({ workProductService: () => ({ listForIssue: mocks.listForIssue }) }));
vi.mock("./issue-review-policy.js", () => ({
  assertIssueReviewVerdictActorAllowed: (...args: unknown[]) => mocks.assertIssueReviewVerdictActorAllowed(...args),
}));

const parent = { id: "parent", companyId: "company", assigneeAgentId: "jarvis" };
const child = { id: "child", companyId: "company", parentId: "parent", status: "done", executionState: null, assigneeAgentId: "specialist", reviewPolicy: null };
const evidence = { id: "wp", issueId: "child", type: "document", status: "ready", healthStatus: "healthy", reviewState: "unreviewed", url: "https://example.test/report", metadata: null };
const pendingHumanState = {
  status: "pending", currentStageId: "00000000-0000-4000-8000-000000000001", currentStageIndex: 0, currentStageType: "approval",
  currentParticipant: { type: "user", userId: "board", agentId: null }, returnAssignee: null,
  reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
  monitor: null, changesRequestedCount: 0,
};

function mockDb(transition: { actorType: "agent" | "user"; actorId: string } | null = null) {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (rows: any[]) => any) => Promise.resolve(resolve(transition ? [transition] : [])),
  };
  return {
    select: () => chain,
  } as unknown as Db;
}


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

  describe("reconcileDelegatedChildCompletion — reviewRequired and independent reviewer QA gate", () => {
  it("returns awaiting_independent_review when reviewRequired=true and child is still in_review", async () => {
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : { ...child, status: "in_review" });
    const result = await reconcileDelegatedChildCompletion(mockDb(), {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: true,
    });
    expect(result).toMatchObject({
      outcome: "awaiting_independent_review",
      reviewRequired: true,
      childStatus: "in_review",
    });
  });

  it("infers reviewRequired=true from child.reviewPolicy='not_creator' when not explicitly specified", async () => {
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : { ...child, status: "in_review", reviewPolicy: "not_creator" });
    const result = await reconcileDelegatedChildCompletion(mockDb(), {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
    });
    expect(result).toMatchObject({
      outcome: "awaiting_independent_review",
      reviewRequired: true,
      childStatus: "in_review",
    });
  });

  it("enforces independent review when child.reviewPolicy='not_creator' even if caller explicitly passes reviewRequired=false", async () => {
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : { ...child, status: "in_review", reviewPolicy: "not_creator" });
    const result = await reconcileDelegatedChildCompletion(mockDb(), {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: false,
    });
    expect(result).toMatchObject({
      outcome: "awaiting_independent_review",
      reviewRequired: true,
      childStatus: "in_review",
    });
  });

  it("fails closed with missing_independent_review when child.reviewPolicy='not_creator' and caller passes reviewRequired=false without verdict", async () => {
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : { ...child, status: "done", reviewPolicy: "not_creator" });
    const db = mockDb(null);
    const result = await reconcileDelegatedChildCompletion(db, {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: false,
    });
    expect(result).toMatchObject({
      outcome: "missing_independent_review",
      reason: "missing_reviewer",
      reviewRequired: true,
    });
  });


  it("fails closed with revision_required (changes_requested) when child executionState has changes_requested", async () => {
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : {
      ...child,
      executionState: { ...pendingHumanState, status: "changes_requested" },
    });
    const result = await reconcileDelegatedChildCompletion(mockDb(), {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: true,
    });
    expect(result).toMatchObject({
      outcome: "revision_required",
      reason: "changes_requested",
    });
  });

  it("fails closed with revision_required (changes_requested) when child executionState.lastDecisionOutcome is changes_requested", async () => {
    mocks.getById.mockImplementation((id: string) => id === "parent" ? parent : {
      ...child,
      executionState: { ...pendingHumanState, status: "idle", lastDecisionOutcome: "changes_requested" },
    });
    const result = await reconcileDelegatedChildCompletion(mockDb(), {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: true,
    });
    expect(result).toMatchObject({
      outcome: "revision_required",
      reason: "changes_requested",
    });
  });


  it("fails closed with missing_independent_review (missing_reviewer) when child is done but no in_review -> done transition is recorded", async () => {
    const db = mockDb(null);
    const result = await reconcileDelegatedChildCompletion(db, {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: true,
    });
    expect(result).toMatchObject({
      outcome: "missing_independent_review",
      reason: "missing_reviewer",
    });
  });

  it("fails closed with invalid_reviewer (executor_cannot_self_review) when transition actor is the executor", async () => {
    const db = mockDb({ actorType: "agent", actorId: "specialist" });
    const result = await reconcileDelegatedChildCompletion(db, {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: true,
    });
    expect(result).toMatchObject({
      outcome: "invalid_reviewer",
      reason: "executor_cannot_self_review",
    });
    expect(mocks.assertIssueReviewVerdictActorAllowed).not.toHaveBeenCalled();
  });

  it("fails closed with invalid_reviewer (review_policy_denied) when review policy check returns 403 forbidden", async () => {
    const db = mockDb({ actorType: "agent", actorId: "reviewer-1" });
    mocks.assertIssueReviewVerdictActorAllowed.mockRejectedValue(new HttpError(403, "Forbidden"));
    const result = await reconcileDelegatedChildCompletion(db, {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: true,
    });
    expect(result).toMatchObject({
      outcome: "invalid_reviewer",
      reason: "review_policy_denied",
    });
  });

  it("fails closed with unable_to_verify_review_authorization when review policy check throws unexpected error", async () => {
    const db = mockDb({ actorType: "agent", actorId: "reviewer-1" });
    mocks.assertIssueReviewVerdictActorAllowed.mockRejectedValue(new Error("Database connection failure"));
    const result = await reconcileDelegatedChildCompletion(db, {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: true,
    });
    expect(result).toMatchObject({
      outcome: "missing_independent_review",
      reason: "unable_to_verify_review_authorization",
    });
  });

  it("returns ready_for_jarvis_review when independent reviewer PASS is canonically verified", async () => {
    const db = mockDb({ actorType: "agent", actorId: "reviewer-1" });
    mocks.assertIssueReviewVerdictActorAllowed.mockResolvedValue(undefined);
    const result = await reconcileDelegatedChildCompletion(db, {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: true,
    });
    expect(result).toMatchObject({
      outcome: "ready_for_jarvis_review",
      reviewRequired: true,
      reviewer: { type: "agent", id: "reviewer-1" },
    });
    expect(mocks.assertIssueReviewVerdictActorAllowed).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        issue: expect.objectContaining({ id: "child" }),
        actor: { type: "agent", id: "reviewer-1" },
        reviewPolicy: "not_creator",
      }),
    );
  });

  it("preserves reviewer as null when reviewRequired is false", async () => {
    const result = await reconcileDelegatedChildCompletion({} as never, {
      companyId: "company",
      parentIssueId: "parent",
      resolvedChildIssueId: "child",
      reviewRequired: false,
    });
    expect(result).toMatchObject({
      outcome: "ready_for_jarvis_review",
      reviewRequired: false,
      reviewer: null,
    });
  });
});
});


