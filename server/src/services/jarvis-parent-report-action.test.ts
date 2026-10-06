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
const childId2 = "00000000-0000-4000-8000-000000000006";
const specialistId2 = "00000000-0000-4000-8000-000000000007";

const parent = { id: parentId, identifier: "NEX-1", companyId, parentId: null, assigneeAgentId: jarvisId };
const child = { id: childId, identifier: "NEX-2", companyId, parentId, assigneeAgentId: specialistId, executionState: null };
const child2 = { id: childId2, identifier: "NEX-3", companyId, parentId, assigneeAgentId: specialistId2, executionState: null };

function readyFor(id: string) {
  return {
    outcome: "ready_for_jarvis_review",
    parentIssueId: parentId,
    childIssueId: id,
    childStatus: "done",
    executionState: null,
    approvalRequired: false,
    approvals: [],
    evidence: { accepted: true, acceptedWorkProductIds: ["wp-1"], reasonCodes: [], problems: [] },
  };
}
const ready = readyFor(childId);

function issuesById(ids: Record<string, unknown>) {
  return async (id: string) => ids[id] ?? null;
}

describe("runJarvisParentReportAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getById.mockImplementation(issuesById({ [parentId]: parent, [childId]: child }));
    mocks.listAcceptedPlanDecompositions.mockResolvedValue([{ id: "d-1", requestFingerprint: "plan-fp", childIssueIds: [childId] }]);
    mocks.listForIssue.mockResolvedValue([{ id: "wp-1", type: "document", status: "ready", reviewState: "accepted", healthStatus: "healthy", url: "https://example.test", metadata: null, updatedAt: new Date("2026-01-01") }]);
    mocks.listApprovalsForIssue.mockResolvedValue([]);
    mocks.reconcile.mockResolvedValue(ready);
    mocks.project.mockReturnValue({ fingerprint: "fp", canonical: {}, body: "report", metadata: {} });
    mocks.write.mockResolvedValue({ outcome: "created", fingerprint: "fp", commentId: "comment-1" });
  });

  it("re-reads canonical state and writes a ready report (single child, regression)", async () => {
    const result = await runJarvisParentReportAction({} as never, { companyId, parentIssueId: parentId, resolvedChildIssueId: childId }, { agentId: jarvisId, runId: "run-1" });
    expect(result.report.outcome).toBe("created");
    expect(mocks.getById).toHaveBeenCalledTimes(4);
    expect(mocks.project).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const canonical = mocks.project.mock.calls[0][0];
    expect(canonical.children).toHaveLength(1);
    expect(canonical.children[0].id).toBe(childId);
  });

  it("resolves workspace_file evidence paths with relativePath -> path -> displayPath priority and whitespace fallback", async () => {
    mocks.listForIssue.mockResolvedValue([
      {
        id: "wp-display-only",
        type: "document",
        status: "ready",
        reviewState: "accepted",
        healthStatus: "healthy",
        url: null,
        metadata: { resourceRef: { kind: "workspace_file", displayPath: "docs/report.md" } },
        updatedAt: new Date("2026-01-01"),
      },
      {
        id: "wp-priority-all",
        type: "document",
        status: "ready",
        reviewState: "accepted",
        healthStatus: "healthy",
        url: null,
        metadata: {
          resourceRef: {
            kind: "workspace_file",
            relativePath: "src/canonical.ts",
            path: "src/legacy.ts",
            displayPath: "Target / src/canonical.ts",
          },
        },
        updatedAt: new Date("2026-01-01"),
      },
      {
        id: "wp-priority-path-over-display",
        type: "document",
        status: "ready",
        reviewState: "accepted",
        healthStatus: "healthy",
        url: null,
        metadata: {
          resourceRef: {
            kind: "workspace_file",
            path: "src/legacy.ts",
            displayPath: "Target / src/legacy.ts",
          },
        },
        updatedAt: new Date("2026-01-01"),
      },
      {
        id: "wp-whitespace-fallback",
        type: "document",
        status: "ready",
        reviewState: "accepted",
        healthStatus: "healthy",
        url: null,
        metadata: {
          resourceRef: {
            kind: "workspace_file",
            relativePath: "   ",
            path: "",
            displayPath: "docs/fallback.md",
          },
        },
        updatedAt: new Date("2026-01-01"),
      },
      {
        id: "wp-whitespace-all-empty",
        type: "document",
        status: "ready",
        reviewState: "accepted",
        healthStatus: "healthy",
        url: null,
        metadata: {
          resourceRef: {
            kind: "workspace_file",
            relativePath: "   ",
            path: " ",
            displayPath: "  ",
          },
        },
        updatedAt: new Date("2026-01-01"),
      },
    ]);

    await runJarvisParentReportAction(
      {} as never,
      { companyId, parentIssueId: parentId, resolvedChildIssueId: childId },
      { agentId: jarvisId, runId: "run-1" },
    );

    const projectedCanonical = mocks.project.mock.calls[0][0];
    const evidenceRefs = projectedCanonical.children[0].evidence.map((e: { id: string; resourceRef: unknown }) => ({
      id: e.id,
      ref: e.resourceRef,
    }));

    expect(evidenceRefs).toEqual([
      { id: "wp-display-only", ref: { kind: "workspace_file", path: "docs/report.md" } },
      { id: "wp-priority-all", ref: { kind: "workspace_file", path: "src/canonical.ts" } },
      { id: "wp-priority-path-over-display", ref: { kind: "workspace_file", path: "src/legacy.ts" } },
      { id: "wp-whitespace-fallback", ref: { kind: "workspace_file", path: "docs/fallback.md" } },
      { id: "wp-whitespace-all-empty", ref: { kind: "workspace_file", path: null } },
    ]);
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

  describe("multi-child decomposition aggregation", () => {
    beforeEach(() => {
      mocks.getById.mockImplementation(issuesById({ [parentId]: parent, [childId]: child, [childId2]: child2 }));
      mocks.listAcceptedPlanDecompositions.mockResolvedValue([{ id: "d-1", requestFingerprint: "plan-fp", childIssueIds: [childId, childId2] }]);
      mocks.listForIssue.mockImplementation(async (id: string) => [{
        id: `wp-${id}`,
        type: "document",
        status: "ready",
        reviewState: "accepted",
        healthStatus: "healthy",
        url: "https://example.test",
        metadata: null,
        updatedAt: new Date("2026-01-01"),
      }]);
      mocks.reconcile.mockImplementation(async (_db: never, input: { resolvedChildIssueId: string }) => ({
        ...readyFor(input.resolvedChildIssueId),
        evidence: { accepted: true, acceptedWorkProductIds: [`wp-${input.resolvedChildIssueId}`], reasonCodes: [], problems: [] },
      }));
    });

    it("aggregates every sibling child into one canonical input regardless of which child was the entry point", async () => {
      const result = await runJarvisParentReportAction({} as never, { companyId, parentIssueId: parentId, resolvedChildIssueId: childId }, { agentId: jarvisId });
      expect(result.report.outcome).toBe("created");
      expect(mocks.project).toHaveBeenCalledTimes(1);
      const canonical = mocks.project.mock.calls[0][0];
      const ids = canonical.children.map((c: { id: string }) => c.id).sort();
      expect(ids).toEqual([childId, childId2].sort());
      // reconcile is called once for the entry child up front, then once per
      // sibling (childId2) -- never re-reconciled a second time for the
      // entry child itself.
      expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    });

    it("does not write a report when any sibling is not ready (no partial completion hidden as success)", async () => {
      mocks.reconcile.mockImplementation(async (_db: never, input: { resolvedChildIssueId: string }) =>
        input.resolvedChildIssueId === childId2
          ? { ...readyFor(childId2), outcome: "revision_required", reason: "changes_requested" }
          : readyFor(childId),
      );
      const result = await runJarvisParentReportAction({} as never, { companyId, parentIssueId: parentId, resolvedChildIssueId: childId }, { agentId: jarvisId });
      expect(result.report).toEqual({ outcome: "not_written" });
      expect(mocks.project).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it("produces the same aggregated canonical children set no matter which child triggers the action", async () => {
      await runJarvisParentReportAction({} as never, { companyId, parentIssueId: parentId, resolvedChildIssueId: childId }, { agentId: jarvisId });
      const fromFirst = mocks.project.mock.calls[0][0].children.map((c: { id: string }) => c.id).sort();
      mocks.project.mockClear();
      await runJarvisParentReportAction({} as never, { companyId, parentIssueId: parentId, resolvedChildIssueId: childId2 }, { agentId: jarvisId });
      const fromSecond = mocks.project.mock.calls[0][0].children.map((c: { id: string }) => c.id).sort();
      expect(fromSecond).toEqual(fromFirst);
    });
  });
});
