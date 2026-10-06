import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JarvisSelectableAgent } from "./jarvis-agent-selector.js";

const mockCreate = vi.fn();
const mockDecomposeAcceptedPlan = vi.fn();
vi.mock("./issues.js", () => ({
  issueService: () => ({
    create: mockCreate,
    decomposeAcceptedPlan: mockDecomposeAcceptedPlan,
  }),
}));

const mockGetIssueDocumentByKey = vi.fn();
const mockUpsertIssueDocument = vi.fn();
vi.mock("./documents.js", () => ({
  documentService: () => ({
    getIssueDocumentByKey: mockGetIssueDocumentByKey,
    upsertIssueDocument: mockUpsertIssueDocument,
  }),
}));

const mockCreateInteraction = vi.fn();
const mockAcceptInteraction = vi.fn();
vi.mock("./issue-thread-interactions.js", () => ({
  issueThreadInteractionService: () => ({
    create: mockCreateInteraction,
    acceptInteraction: mockAcceptInteraction,
  }),
}));

const mockListCompanyAgentsForDelegation = vi.fn();
const mockGetAgentByIdForDelegation = vi.fn();
vi.mock("./jarvis-agent-directory.js", () => ({
  listCompanyAgentsForDelegation: (...args: unknown[]) => mockListCompanyAgentsForDelegation(...args),
  getAgentByIdForDelegation: (...args: unknown[]) => mockGetAgentByIdForDelegation(...args),
}));

import { submitToJarvis } from "./jarvis-delegation-orchestrator.js";

const COMPANY = "company-1";
const JARVIS_ID = "agent-jarvis";
const SPECIALIST_ID = "agent-specialist";
const FAKE_DB = {} as never;

function agent(overrides: Partial<JarvisSelectableAgent> & { id: string }): JarvisSelectableAgent {
  return {
    companyId: COMPANY,
    name: overrides.id,
    status: "idle",
    reportsTo: null,
    adapterType: "codex_local",
    capabilities: null,
    ...overrides,
  };
}

function validPlan(overrides: Record<string, unknown> = {}) {
  return {
    objective: "Fix the flaky login test",
    acceptanceCriteria: ["The flaky test passes 10/10 consecutive runs"],
    evidenceRequirements: ["targeted_test"],
    taskClass: "development" as const,
    tasks: [
      {
        title: "Stabilize login test",
        instructions: "Investigate and fix the race condition in the login test.",
        requiredCapabilities: [],
        dependencies: [],
        riskHints: [],
      },
    ],
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY,
    requestedByUserId: "user-1",
    jarvisAgentId: JARVIS_ID,
    requestText: "Fix the flaky login test",
    sourceType: "paperclip_ui",
    plan: validPlan(),
    ...overrides,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockDecomposeAcceptedPlan.mockReset();
  mockGetIssueDocumentByKey.mockReset();
  mockUpsertIssueDocument.mockReset();
  mockCreateInteraction.mockReset();
  mockAcceptInteraction.mockReset();
  mockListCompanyAgentsForDelegation.mockReset();
  mockGetAgentByIdForDelegation.mockReset();

  mockListCompanyAgentsForDelegation.mockResolvedValue([
    agent({ id: JARVIS_ID }),
    agent({ id: SPECIALIST_ID }),
  ]);
  mockCreate.mockImplementation(async (_companyId: string, data: Record<string, unknown>) => ({
    id: "parent-issue-1", projectId: null, goalId: null, status: "todo",
    ...data,
  }));
  mockGetIssueDocumentByKey.mockResolvedValue(null);
  mockUpsertIssueDocument.mockResolvedValue({
    document: { id: "plan-document-1", latestRevisionId: "plan-revision-1", latestRevisionNumber: 1 },
  });
  mockCreateInteraction.mockResolvedValue({ id: "confirmation-1", status: "pending" });
  mockAcceptInteraction.mockResolvedValue({ interaction: { id: "confirmation-1", status: "accepted" } });
  mockDecomposeAcceptedPlan.mockImplementation(async (_parentId: string, data: Record<string, any>) => ({
    childIssues: [{ id: "child-issue-1", ...data.children[0] }],
    childIssueIds: ["child-issue-1"],
    newlyCreatedIssues: [{ id: "child-issue-1" }],
  }));
});

describe("submitToJarvis — successful parent and child creation", () => {
  it("creates a parent Issue assigned to JARVIS and a child Issue assigned to the selected specialist", async () => {
    const result = await submitToJarvis(FAKE_DB, baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.parentIssueId).toBe("parent-issue-1");
    expect(result.childIssueId).toBe("child-issue-1");
    expect(result.selectedAgentId).toBe(SPECIALIST_ID);
    expect(result.reasonCodes).toContain("child_issue_created");

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockCreate.mock.calls[0]![1];
    expect(createArgs.assigneeAgentId).toBe(JARVIS_ID);
    expect(createArgs.status).toBe("todo");

    expect(mockDecomposeAcceptedPlan).toHaveBeenCalledTimes(1);
    const [childParentId, decompositionArgs] = mockDecomposeAcceptedPlan.mock.calls[0]!;
    const childArgs = decompositionArgs.children[0];
    expect(childParentId).toBe("parent-issue-1");
    expect(childArgs.assigneeAgentId).toBe(SPECIALIST_ID);
    expect(childArgs.blockParentUntilDone).toBe(true);
    expect(childArgs.status).toBe("todo");
  });

  it("returns canonical Paperclip identifiers, not fabricated ones", async () => {
    mockCreate.mockResolvedValueOnce({ id: "real-parent-id" });
    mockDecomposeAcceptedPlan.mockResolvedValueOnce({ childIssues: [{ id: "real-child-id" }] });
    const result = await submitToJarvis(FAKE_DB, baseInput());
    if (!result.ok) throw new Error("expected success");
    expect(result.parentIssueId).toBe("real-parent-id");
    expect(result.childIssueId).toBe("real-child-id");
  });
});

describe("submitToJarvis — idempotency and reuse", () => {
  it("passes an idempotencyKey to issueService.create for the parent Issue", async () => {
    await submitToJarvis(FAKE_DB, baseInput());
    const createArgs = mockCreate.mock.calls[0]![1];
    expect(typeof createArgs.idempotencyKey).toBe("string");
    expect(createArgs.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("passes the plan fingerprint as the child Issue's idempotencyKey", async () => {
    await submitToJarvis(FAKE_DB, baseInput());
    const childArgs = mockDecomposeAcceptedPlan.mock.calls[0]![1].children[0];
    expect(typeof childArgs.idempotencyKey).toBe("string");
    expect(childArgs.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("reuses the same intake fingerprint across two calls with identical logical input (no parallel idempotency store)", async () => {
    await submitToJarvis(FAKE_DB, baseInput());
    await submitToJarvis(FAKE_DB, baseInput());
    const firstKey = mockCreate.mock.calls[0]![1].idempotencyKey;
    const secondKey = mockCreate.mock.calls[1]![1].idempotencyKey;
    expect(firstKey).toBe(secondKey);
  });

  it("surfaces deduplication when issueService.create's onDeduplicated callback fires (simulating the real dedup path)", async () => {
    mockCreate.mockImplementationOnce(async (_companyId: string, data: Record<string, unknown> & { onDeduplicated?: (r: string) => void }) => {
      data.onDeduplicated?.("idempotency_key");
      return { id: "existing-parent-id" };
    });
    const result = await submitToJarvis(FAKE_DB, baseInput());
    if (!result.ok) throw new Error("expected success");
    expect(result.parentIssueId).toBe("existing-parent-id");
    expect(result.parentIssueDeduplicated).toBe(true);
    expect(result.reasonCodes).toContain("parent_issue_reused");
  });

  it("respects an explicit client-supplied idempotencyKey over the computed fingerprint", async () => {
    await submitToJarvis(FAKE_DB, baseInput({ idempotencyKey: "client-key-abc" }));
    const createArgs = mockCreate.mock.calls[0]![1];
    expect(createArgs.idempotencyKey).toBe("client-key-abc");
  });
});

describe("submitToJarvis — deterministic agent selection", () => {
  it("selects the lowest-priority eligible specialist deterministically", async () => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([
      agent({ id: JARVIS_ID }),
      agent({ id: "agent-low-priority", priority: 5 }),
      agent({ id: "agent-high-priority", priority: 1 }),
    ]);
    const result = await submitToJarvis(FAKE_DB, baseInput());
    if (!result.ok) throw new Error("expected success");
    expect(result.selectedAgentId).toBe("agent-high-priority");
  });

  it("never selects JARVIS itself as the specialist", async () => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([agent({ id: JARVIS_ID })]);
    const result = await submitToJarvis(FAKE_DB, baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("no_eligible_specialist");
  });
});

describe("submitToJarvis — cross-company rejection", () => {
  it("rejects when JARVIS's agent record belongs to a different company than requested", async () => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([]);
    mockGetAgentByIdForDelegation.mockResolvedValue(agent({ id: JARVIS_ID, companyId: "company-2" }));
    const result = await submitToJarvis(FAKE_DB, baseInput({ companyId: COMPANY }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("jarvis_cross_company");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDecomposeAcceptedPlan).not.toHaveBeenCalled();
  });
});

describe("submitToJarvis — missing or ineligible JARVIS / specialist rejection", () => {
  it("rejects when the JARVIS agent id does not resolve to any agent", async () => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([]);
    mockGetAgentByIdForDelegation.mockResolvedValue(null);
    const result = await submitToJarvis(FAKE_DB, baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("jarvis_not_found");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects when JARVIS is not invokable (terminated)", async () => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([
      agent({ id: JARVIS_ID, status: "terminated" }),
      agent({ id: SPECIALIST_ID }),
    ]);
    const result = await submitToJarvis(FAKE_DB, baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("jarvis_not_invokable");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects with no_eligible_specialist but still reports the already-created parentIssueId when no specialist qualifies", async () => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([agent({ id: JARVIS_ID })]);
    const result = await submitToJarvis(FAKE_DB, baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("no_eligible_specialist");
    expect(result.parentIssueId).toBe("parent-issue-1");
    expect(mockDecomposeAcceptedPlan).not.toHaveBeenCalled();
  });
});

describe("submitToJarvis — invalid delegation depth and child-count rejection", () => {
  it("rejects a depthBelowParent beyond the configured maximum", async () => {
    const result = await submitToJarvis(FAKE_DB, baseInput({ depthBelowParent: 5 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("plan_limits_violated");
    expect(result.parentIssueId).toBe("parent-issue-1");
    expect(mockDecomposeAcceptedPlan).not.toHaveBeenCalled();
  });

  it("accepts the default depthBelowParent (a direct child of the JARVIS parent)", async () => {
    const result = await submitToJarvis(FAKE_DB, baseInput());
    expect(result.ok).toBe(true);
  });

  it("rejects a plan with more tasks than delegationPlanSchema's own max(5) cap (the same JARVIS_DELEGATION_MAX_CHILDREN_PER_DECISION limit, enforced earlier by the schema itself)", async () => {
    const tooManyTasksPlan = validPlan({
      tasks: Array.from({ length: 6 }, (_, i) => ({
        title: `Task ${i}`, instructions: `do ${i}`, requiredCapabilities: [], dependencies: [], riskHints: [],
      })),
    });
    const result = await submitToJarvis(FAKE_DB, baseInput({ plan: tooManyTasksPlan }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("invalid_plan");
    expect(mockDecomposeAcceptedPlan).not.toHaveBeenCalled();
  });
});

describe("submitToJarvis — multi-child delegation (distinct specialist per task)", () => {
  const SPECIALIST_B_ID = "agent-specialist-b";

  beforeEach(() => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([
      agent({ id: JARVIS_ID }),
      agent({ id: SPECIALIST_ID }),
      agent({ id: SPECIALIST_B_ID }),
    ]);
    mockDecomposeAcceptedPlan.mockImplementation(async (_parentId: string, data: Record<string, any>) => ({
      childIssues: data.children.map((child: Record<string, unknown>, i: number) => ({ id: `child-issue-${i + 1}`, ...child })),
      childIssueIds: data.children.map((_: unknown, i: number) => `child-issue-${i + 1}`),
      newlyCreatedIssues: data.children.map((_: unknown, i: number) => ({ id: `child-issue-${i + 1}` })),
    }));
  });

  const twoTaskPlan = () => validPlan({
    tasks: [
      { title: "A", instructions: "do a", requiredCapabilities: [], dependencies: [], riskHints: [] },
      { title: "B", instructions: "do b", requiredCapabilities: [], dependencies: [], riskHints: [] },
    ],
  });

  it("creates one child per task, each assigned to a distinct specialist, with a unique idempotencyKey per child", async () => {
    const result = await submitToJarvis(FAKE_DB, baseInput({ plan: twoTaskPlan() }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");

    expect(result.childAssignments).toHaveLength(2);
    const specialistIds = result.childAssignments.map((a) => a.selectedAgentId);
    expect(new Set(specialistIds).size).toBe(2); // genuinely distinct, not the same agent twice
    expect(specialistIds.sort()).toEqual([SPECIALIST_B_ID, SPECIALIST_ID].sort());

    expect(mockDecomposeAcceptedPlan).toHaveBeenCalledTimes(1);
    const children = mockDecomposeAcceptedPlan.mock.calls[0]![1].children;
    expect(children).toHaveLength(2);
    expect(new Set(children.map((c: any) => c.assigneeAgentId)).size).toBe(2);
    const keys = children.map((c: any) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(2); // no two children share an idempotencyKey

    // Backward-compat singular fields mirror the first assignment.
    expect(result.childIssueId).toBe(result.childAssignments[0]!.childIssueId);
    expect(result.selectedAgentId).toBe(result.childAssignments[0]!.selectedAgentId);
  });

  it("respects each task's own required capabilities while still assigning distinct specialists", async () => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([
      agent({ id: JARVIS_ID }),
      agent({ id: SPECIALIST_ID, capabilities: "typescript" }),
      agent({ id: SPECIALIST_B_ID, capabilities: "python" }),
    ]);
    const plan = validPlan({
      tasks: [
        { title: "TS task", instructions: "do ts", requiredCapabilities: ["typescript"], dependencies: [], riskHints: [] },
        { title: "Py task", instructions: "do py", requiredCapabilities: ["python"], dependencies: [], riskHints: [] },
      ],
    });
    const result = await submitToJarvis(FAKE_DB, baseInput({ plan }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.childAssignments[0]!.selectedAgentId).toBe(SPECIALIST_ID);
    expect(result.childAssignments[1]!.selectedAgentId).toBe(SPECIALIST_B_ID);
  });

  it("fails closed with zero children created when a later task has no remaining eligible specialist", async () => {
    // Only ONE non-JARVIS agent exists -- task A consumes it, leaving nothing for task B.
    mockListCompanyAgentsForDelegation.mockResolvedValue([
      agent({ id: JARVIS_ID }),
      agent({ id: SPECIALIST_ID }),
    ]);
    const result = await submitToJarvis(FAKE_DB, baseInput({ plan: twoTaskPlan() }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("no_eligible_specialist");
    expect(result.detail).toContain("B"); // names the task that actually failed
    expect(mockDecomposeAcceptedPlan).not.toHaveBeenCalled();
  });

  it("stays within the existing 5-child-per-decision limit without inventing a new one", async () => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([
      agent({ id: JARVIS_ID }),
      ...Array.from({ length: 5 }, (_, i) => agent({ id: `agent-${i}` })),
    ]);
    const fiveTaskPlan = validPlan({
      tasks: Array.from({ length: 5 }, (_, i) => ({
        title: `Task ${i}`, instructions: `do ${i}`, requiredCapabilities: [], dependencies: [], riskHints: [],
      })),
    });
    const result = await submitToJarvis(FAKE_DB, baseInput({ plan: fiveTaskPlan }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.childAssignments).toHaveLength(5);
    expect(new Set(result.childAssignments.map((a) => a.selectedAgentId)).size).toBe(5);
  });
});

describe("submitToJarvis — invalid input", () => {
  it("rejects a missing companyId before touching any service", async () => {
    const result = await submitToJarvis(FAKE_DB, baseInput({ companyId: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("invalid_input");
    expect(mockListCompanyAgentsForDelegation).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an invalid plan shape (empty acceptanceCriteria)", async () => {
    const result = await submitToJarvis(FAKE_DB, baseInput({ plan: validPlan({ acceptanceCriteria: [] }) }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("invalid_plan");
    expect(result.parentIssueId).toBe("parent-issue-1");
    expect(mockDecomposeAcceptedPlan).not.toHaveBeenCalled();
  });
});

describe("submitToJarvis — canonical approval and no fabricated completion state", () => {
  it("never creates or requests an Issue status of done for the parent or child", async () => {
    await submitToJarvis(FAKE_DB, baseInput());
    const createArgs = mockCreate.mock.calls[0]![1];
    const childArgs = mockDecomposeAcceptedPlan.mock.calls[0]![1].children[0];
    expect(createArgs.status).not.toBe("done");
    expect(childArgs.status).not.toBe("done");
  });

  it("records and accepts the Board-submitted plan before canonical decomposition", async () => {
    const result = await submitToJarvis(FAKE_DB, baseInput());
    expect(result.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpsertIssueDocument).toHaveBeenCalledTimes(1);
    expect(mockCreateInteraction).toHaveBeenCalledTimes(1);
    expect(mockAcceptInteraction).toHaveBeenCalledTimes(1);
    expect(mockDecomposeAcceptedPlan).toHaveBeenCalledTimes(1);
    if (!result.ok) throw new Error("expected success");
    expect(result.reasonCodes).toContain("accepted_plan_recorded");
  });
});

describe("submitToJarvis — wakeup is injectable and optional", () => {
  it("does not throw when no wakeup executor is injected", async () => {
    await expect(submitToJarvis(FAKE_DB, baseInput())).resolves.toMatchObject({ ok: true });
  });

  it("invokes the injected wakeup executor for the child assignment when provided", async () => {
    const wakeup = vi.fn().mockResolvedValue(undefined);
    const result = await submitToJarvis(FAKE_DB, baseInput(), { wakeup });
    if (!result.ok) throw new Error("expected success");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      SPECIALIST_ID,
      expect.objectContaining({ source: "assignment" }),
    );
  });
});

describe("submitToJarvis — reviewRequired and independent reviewer selection", () => {
  const REVIEWER_ID = "agent-reviewer";

  it("selects an independent reviewer and sets reviewPolicy to not_creator when reviewRequired=true", async () => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([
      agent({ id: JARVIS_ID }),
      agent({ id: SPECIALIST_ID, priority: 1 }),
      agent({ id: REVIEWER_ID, priority: 2 }),
    ]);

    const result = await submitToJarvis(
      FAKE_DB,
      baseInput({ plan: validPlan({ reviewRequired: true }) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.selectedAgentId).toBe(SPECIALIST_ID);
    expect(result.reviewerAgentId).toBe(REVIEWER_ID);
    expect(mockDecomposeAcceptedPlan).toHaveBeenCalledWith(
      "parent-issue-1",
      expect.objectContaining({
        children: [
          expect.objectContaining({
            reviewPolicy: "not_creator",
            executionPolicy: {
              stages: [
                {
                  type: "review",
                  participants: [{ type: "agent", agentId: REVIEWER_ID }],
                },
              ],
            },
          }),
        ],
      }),
    );
  });

  it("fails closed with no_eligible_reviewer when reviewRequired=true but no independent reviewer is available", async () => {
    // Only JARVIS and the specialist exist
    mockListCompanyAgentsForDelegation.mockResolvedValue([
      agent({ id: JARVIS_ID }),
      agent({ id: SPECIALIST_ID }),
    ]);

    const result = await submitToJarvis(
      FAKE_DB,
      baseInput({ plan: validPlan({ reviewRequired: true }) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("no_eligible_reviewer");
    expect(result.parentIssueId).toBe("parent-issue-1");
    expect(mockDecomposeAcceptedPlan).not.toHaveBeenCalled();
  });

  it("preserves reviewPolicy=null and selects no reviewer when reviewRequired is false or omitted", async () => {
    mockListCompanyAgentsForDelegation.mockResolvedValue([
      agent({ id: JARVIS_ID }),
      agent({ id: SPECIALIST_ID, priority: 1 }),
      agent({ id: REVIEWER_ID, priority: 2 }),
    ]);

    const result = await submitToJarvis(
      FAKE_DB,
      baseInput({ plan: validPlan({ reviewRequired: false }) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.reviewerAgentId).toBeNull();
    expect(mockDecomposeAcceptedPlan).toHaveBeenCalledWith(
      "parent-issue-1",
      expect.objectContaining({
        children: [
          expect.objectContaining({
            reviewPolicy: null,
          }),
        ],
      }),
    );
    const childArgs = mockDecomposeAcceptedPlan.mock.calls[0]![1].children[0];
    expect(childArgs.executionPolicy).toBeUndefined();
  });
});


