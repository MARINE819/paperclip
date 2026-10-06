import { issueComments, issues } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectJarvisParentReport,
  type JarvisParentReportCanonicalInput,
  type JarvisParentReportChildInput,
} from "./jarvis-parent-report-projector.js";
import { writeJarvisParentReport } from "./jarvis-parent-report-writer.js";

const addComment = vi.hoisted(() => vi.fn());
vi.mock("./issues.js", () => ({ issueService: () => ({ addComment }) }));

const companyId = "00000000-0000-4000-8000-000000000001";
const jarvisAgentId = "00000000-0000-4000-8000-000000000002";
const parentId = "00000000-0000-4000-8000-000000000003";
const childId = "00000000-0000-4000-8000-000000000004";
const specialistId = "00000000-0000-4000-8000-000000000005";
const childId2 = "00000000-0000-4000-8000-000000000006";
const specialistId2 = "00000000-0000-4000-8000-000000000007";

const readyReconciliation = { outcome: "ready_for_jarvis_review" as const, parentIssueId: parentId, childIssueId: childId, childStatus: "done", executionState: null, approvalRequired: false, approvals: [], evidence: { accepted: true, acceptedWorkProductIds: ["wp-1"], reasonCodes: [], problems: [] } };

const childInput: JarvisParentReportChildInput = {
  id: childId,
  identifier: "NEX-2",
  parentId,
  assigneeAgentId: specialistId,
  reconciliation: readyReconciliation,
  evidence: [{ id: "wp-1", type: "document", status: "ready", healthStatus: "healthy", url: "https://example.test", resourceRef: null, fingerprint: "wp-fp" }],
};

const canonical: JarvisParentReportCanonicalInput = {
  companyId,
  jarvisAgentId,
  parent: { id: parentId, identifier: "NEX-1", assigneeAgentId: jarvisAgentId },
  acceptedPlan: { decompositionId: "d-1", fingerprint: "plan-fp", childIssueIds: [childId] },
  children: [childInput],
  approvalStateFingerprint: "approval-fp",
  executionStateFingerprint: "execution-fp",
};

type IssueRow = { id: string; companyId: string; parentId?: string | null; assigneeAgentId: string | null };

function fakeDb(records: { parent: IssueRow; children: IssueRow[] }) {
  const comments: Array<{ id: string; fingerprint: string }> = [];
  let gate = Promise.resolve();
  let activeFingerprint = "";
  const findLockKey = (value: unknown): string | null => {
    if (typeof value === "string" && value.startsWith("jarvis-parent-report:")) return value;
    if (!value || typeof value !== "object") return null;
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const found = findLockKey(entry);
      if (found) return found;
    }
    return null;
  };
  const orderedRows = [records.parent, ...records.children];
  let readIndex = 0;
  const tx = {
    execute: vi.fn((query: unknown) => {
      const lockKey = findLockKey(query);
      activeFingerprint = lockKey?.split(`${parentId}:`)[1] ?? activeFingerprint;
    }),
    select: vi.fn(() => ({
      from: (table: unknown) => ({ where: () => {
        if (table === issueComments) {
          const rows = comments.filter((entry) => entry.fingerprint === activeFingerprint).map((entry) => ({ id: entry.id }));
          return { limit: () => ({ then: (resolve: (value: unknown[]) => unknown) => resolve(rows) }) };
        }
        const row = table === issues ? orderedRows[readIndex] ?? null : null;
        readIndex += 1;
        return { then: (resolve: (value: unknown[]) => unknown) => resolve(row ? [row] : []) };
      } }),
    })),
  };
  addComment.mockImplementation(async (_id, _body, _actor, options) => {
    const id = `comment-${comments.length + 1}`;
    const fingerprint = options.metadata.sections[0].rows[0].value;
    comments.push({ id, fingerprint });
    return { id };
  });
  return {
    db: {
      transaction: async (callback: (value: typeof tx) => Promise<unknown>) => {
        const previous = gate;
        let release!: () => void;
        gate = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        readIndex = 0;
        try { return await callback(tx); } finally { release(); }
      },
    } as never,
    comments,
  };
}

function defaultParent(overrides?: Partial<IssueRow>): IssueRow {
  return { id: parentId, companyId, assigneeAgentId: jarvisAgentId, ...overrides };
}
function defaultChild(overrides?: Partial<IssueRow>): IssueRow {
  return { id: childId, companyId, parentId, assigneeAgentId: specialistId, ...overrides };
}

describe("writeJarvisParentReport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates one comment for identical sequential and concurrent calls", async () => {
    const { db, comments } = fakeDb({ parent: defaultParent(), children: [defaultChild()] });
    const projection = projectJarvisParentReport(canonical)!;
    const sequential = await writeJarvisParentReport(db, projection, { agentId: jarvisAgentId });
    const duplicate = await writeJarvisParentReport(db, projection, { agentId: jarvisAgentId });
    const concurrent = await Promise.all([
      writeJarvisParentReport(db, projection, { agentId: jarvisAgentId }),
      writeJarvisParentReport(db, projection, { agentId: jarvisAgentId }),
    ]);
    expect(sequential.outcome).toBe("created");
    expect(duplicate.outcome).toBe("deduplicated");
    expect(concurrent.every((entry) => entry.outcome === "deduplicated")).toBe(true);
    expect(comments).toHaveLength(1);
    expect(addComment).toHaveBeenCalledTimes(1);
  });

  it("allows a changed canonical fingerprint as a new revision", async () => {
    const { db, comments } = fakeDb({ parent: defaultParent(), children: [defaultChild()] });
    await writeJarvisParentReport(db, projectJarvisParentReport(canonical)!, { agentId: jarvisAgentId });
    await writeJarvisParentReport(db, projectJarvisParentReport({ ...canonical, executionStateFingerprint: "execution-fp-2" })!, { agentId: jarvisAgentId });
    expect(comments).toHaveLength(2);
  });

  it.each([
    [{ parentCompanyId: "other" }, "company_mismatch"],
    [{ childParentId: "other" }, "parent_mismatch"],
    [{ parentAssigneeAgentId: "other" }, "jarvis_assignment_mismatch"],
    [{ childAssigneeAgentId: "other" }, "child_assignment_mismatch"],
  ])("rejects canonical relationship mismatches before mutation", async (overrides: Record<string, string>, error) => {
    const { db, comments } = fakeDb({
      parent: defaultParent(overrides.parentCompanyId ? { companyId: overrides.parentCompanyId } : overrides.parentAssigneeAgentId ? { assigneeAgentId: overrides.parentAssigneeAgentId } : undefined),
      children: [defaultChild(overrides.childParentId ? { parentId: overrides.childParentId } : overrides.childAssigneeAgentId ? { assigneeAgentId: overrides.childAssigneeAgentId } : undefined)],
    });
    await expect(writeJarvisParentReport(db, projectJarvisParentReport(canonical)!, { agentId: jarvisAgentId })).rejects.toThrow(error);
    expect(comments).toHaveLength(0);
    expect(addComment).not.toHaveBeenCalled();
  });

  it("rejects accepted-plan and actor mismatches before mutation", async () => {
    const { db, comments } = fakeDb({ parent: defaultParent(), children: [defaultChild()] });
    const badPlan = projectJarvisParentReport({ ...canonical, acceptedPlan: { ...canonical.acceptedPlan, childIssueIds: [] } })!;
    await expect(writeJarvisParentReport(db, badPlan, { agentId: jarvisAgentId })).rejects.toThrow("child_not_in_accepted_plan");
    await expect(writeJarvisParentReport(db, projectJarvisParentReport(canonical)!, { agentId: "other" })).rejects.toThrow("jarvis_assignment_mismatch");
    expect(comments).toHaveLength(0);
  });

  describe("multi-child decomposition", () => {
    const secondChildInput: JarvisParentReportChildInput = {
      id: childId2,
      identifier: "NEX-3",
      parentId,
      assigneeAgentId: specialistId2,
      reconciliation: { ...readyReconciliation, childIssueId: childId2 },
      evidence: [{ id: "wp-2", type: "document", status: "ready", healthStatus: "healthy", url: "https://example.test/2", resourceRef: null, fingerprint: "wp-fp-2" }],
    };
    const multiChildCanonical: JarvisParentReportCanonicalInput = {
      ...canonical,
      acceptedPlan: { ...canonical.acceptedPlan, childIssueIds: [childId, childId2] },
      children: [childInput, secondChildInput],
    };

    it("writes exactly one aggregated comment, deduplicating a second identical call", async () => {
      const { db, comments } = fakeDb({ parent: defaultParent(), children: [defaultChild(), defaultChild({ id: childId2, assigneeAgentId: specialistId2 })] });
      const projection = projectJarvisParentReport(multiChildCanonical)!;
      const first = await writeJarvisParentReport(db, projection, { agentId: jarvisAgentId });
      const second = await writeJarvisParentReport(db, projection, { agentId: jarvisAgentId });
      expect(first.outcome).toBe("created");
      expect(second.outcome).toBe("deduplicated");
      expect(comments).toHaveLength(1);
      expect(addComment).toHaveBeenCalledTimes(1);
    });

    it("rejects before mutation when any one sibling fails relationship verification", async () => {
      const { db, comments } = fakeDb({
        parent: defaultParent(),
        children: [defaultChild(), defaultChild({ id: childId2, assigneeAgentId: "other" })],
      });
      const projection = projectJarvisParentReport(multiChildCanonical)!;
      await expect(writeJarvisParentReport(db, projection, { agentId: jarvisAgentId })).rejects.toThrow("child_assignment_mismatch");
      expect(comments).toHaveLength(0);
      expect(addComment).not.toHaveBeenCalled();
    });
  });
});
