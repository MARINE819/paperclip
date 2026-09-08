import { issueComments, issues } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectJarvisParentReport, type JarvisParentReportCanonicalInput } from "./jarvis-parent-report-projector.js";
import { writeJarvisParentReport } from "./jarvis-parent-report-writer.js";

const addComment = vi.hoisted(() => vi.fn());
vi.mock("./issues.js", () => ({ issueService: () => ({ addComment }) }));

const companyId = "00000000-0000-4000-8000-000000000001";
const jarvisAgentId = "00000000-0000-4000-8000-000000000002";
const parentId = "00000000-0000-4000-8000-000000000003";
const childId = "00000000-0000-4000-8000-000000000004";
const specialistId = "00000000-0000-4000-8000-000000000005";

const canonical: JarvisParentReportCanonicalInput = {
  companyId,
  jarvisAgentId,
  parent: { id: parentId, identifier: "NEX-1", assigneeAgentId: jarvisAgentId },
  child: { id: childId, identifier: "NEX-2", parentId, assigneeAgentId: specialistId },
  acceptedPlan: { decompositionId: "d-1", fingerprint: "plan-fp", childIssueIds: [childId] },
  reconciliation: { outcome: "ready_for_jarvis_review", parentIssueId: parentId, childIssueId: childId, childStatus: "done", executionState: null, approvalRequired: false, approvals: [], evidence: { accepted: true, acceptedWorkProductIds: ["wp-1"], reasonCodes: [], problems: [] } },
  evidence: [{ id: "wp-1", type: "document", status: "ready", healthStatus: "healthy", url: "https://example.test", resourceRef: null, fingerprint: "wp-fp" }],
  approvalStateFingerprint: "approval-fp",
  executionStateFingerprint: "execution-fp",
};

function fakeDb(overrides?: { parentCompanyId?: string; childParentId?: string; parentAssigneeAgentId?: string | null; childAssigneeAgentId?: string | null }) {
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
  const tx = {
    execute: vi.fn((query: unknown) => {
      const lockKey = findLockKey(query);
      activeFingerprint = lockKey?.split(`${parentId}:`)[1] ?? activeFingerprint;
    }),
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = table === issues
            ? []
            : comments.map((entry) => ({ id: entry.id }));
          return {
            then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
            limit: () => ({ then: (resolve: (value: unknown[]) => unknown) => resolve(rows) }),
          };
        },
      }),
    })),
  };
  let issueRead = 0;
  tx.select.mockImplementation(() => ({
    from: (table: unknown) => ({ where: () => {
      if (table === issueComments) {
        const rows = comments.filter((entry) => entry.fingerprint === activeFingerprint).map((entry) => ({ id: entry.id }));
        return { limit: () => ({ then: (resolve: (value: unknown[]) => unknown) => resolve(rows) }) };
      }
      issueRead += 1;
      const row = issueRead % 2 === 1
        ? { id: parentId, companyId: overrides?.parentCompanyId ?? companyId, assigneeAgentId: overrides?.parentAssigneeAgentId ?? jarvisAgentId }
        : { id: childId, companyId, parentId: overrides?.childParentId ?? parentId, assigneeAgentId: overrides?.childAssigneeAgentId ?? specialistId };
      return { then: (resolve: (value: unknown[]) => unknown) => resolve([row]) };
    } }),
  }) as never);
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
        issueRead = 0;
        try { return await callback(tx); } finally { release(); }
      },
    } as never,
    comments,
  };
}

describe("writeJarvisParentReport", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates one comment for identical sequential and concurrent calls", async () => {
    const { db, comments } = fakeDb();
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
    const { db, comments } = fakeDb();
    await writeJarvisParentReport(db, projectJarvisParentReport(canonical)!, { agentId: jarvisAgentId });
    await writeJarvisParentReport(db, projectJarvisParentReport({ ...canonical, executionStateFingerprint: "execution-fp-2" })!, { agentId: jarvisAgentId });
    expect(comments).toHaveLength(2);
  });

  it.each([
    [{ parentCompanyId: "other" }, "company_mismatch"],
    [{ childParentId: "other" }, "parent_mismatch"],
    [{ parentAssigneeAgentId: "other" }, "jarvis_assignment_mismatch"],
    [{ childAssigneeAgentId: "other" }, "child_assignment_mismatch"],
  ])("rejects canonical relationship mismatches before mutation", async (overrides, error) => {
    const { db, comments } = fakeDb(overrides);
    await expect(writeJarvisParentReport(db, projectJarvisParentReport(canonical)!, { agentId: jarvisAgentId })).rejects.toThrow(error);
    expect(comments).toHaveLength(0);
    expect(addComment).not.toHaveBeenCalled();
  });

  it("rejects accepted-plan and actor mismatches before mutation", async () => {
    const { db, comments } = fakeDb();
    const badPlan = projectJarvisParentReport({ ...canonical, acceptedPlan: { ...canonical.acceptedPlan, childIssueIds: [] } })!;
    await expect(writeJarvisParentReport(db, badPlan, { agentId: jarvisAgentId })).rejects.toThrow("child_not_in_accepted_plan");
    await expect(writeJarvisParentReport(db, projectJarvisParentReport(canonical)!, { agentId: "other" })).rejects.toThrow("jarvis_assignment_mismatch");
    expect(comments).toHaveLength(0);
  });
});
