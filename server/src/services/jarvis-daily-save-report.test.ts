import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { agents, agentWakeupRequests, approvals, heartbeatRuns, issueWorkProducts, issues } from "@paperclipai/db";

const mockApprovalsCreate = vi.hoisted(() => vi.fn(async (_companyId: string, data: any) => ({ id: "approval-1", ...data })));
vi.mock("./approvals.js", () => ({
  approvalService: vi.fn(() => ({ create: mockApprovalsCreate })),
}));

// Defaults to a valid, same-company agent so every existing test (all using
// companyId "company-1") keeps passing unchanged; the 2 new security tests
// override this per-call to exercise the "not found" / "cross-company" paths.
const mockGetAgentByIdForDelegation = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ id: string; companyId: string } | null> => ({
      id: "jarvis-agent-1",
      companyId: "company-1",
    }),
  ),
);
vi.mock("./jarvis-agent-directory.js", () => ({
  getAgentByIdForDelegation: mockGetAgentByIdForDelegation,
}));

import {
  computeTodayKstDateString,
  runDailySaveCollector,
  generateDailyGitSaveReportAndApproval,
  buildPaperclipSnapshotForDailySave,
} from "./jarvis-daily-save-report.js";

describe("computeTodayKstDateString", () => {
  it("rolls over to the next KST day before UTC midnight", () => {
    const result = computeTodayKstDateString(new Date("2026-11-01T15:30:00.000Z"));
    expect(result).toBe("2026-11-02");
  });

  it("does not roll over just before the KST boundary", () => {
    const result = computeTodayKstDateString(new Date("2026-11-01T14:59:00.000Z"));
    expect(result).toBe("2026-11-01");
  });
});

const SAMPLE_RESULT = {
  kstWindow: { dateKst: "2026-11-02" },
  summaryCounts: {
    totalWorkingTreeChanges: 6,
    saveCandidateCount: 1,
    needsReviewCount: 2,
    excludedCount: 3,
    todayCommitCount: 0,
    completedIssueCount: 0,
    runnerRunCount: 0,
    uninspectableSourceCount: 1,
  },
  gitSaveHandOff: { readyForPrepare: true },
  classifications: {
    saveCandidates: [{ path: "a.ts" }],
    needsReview: [{ path: "b.ts" }, { path: "c.ts" }],
    excluded: [{ path: "d.ts" }, { path: "e.ts" }, { path: "f.ts" }],
  },
};

function makeOkExecFileImpl() {
  return (async (_cmd: string, args: readonly string[]) => {
    const jsonOutPath = args[args.indexOf("--json-out") + 1] as string;
    const reportOutPath = args[args.indexOf("--report-out") + 1] as string;
    await writeFile(jsonOutPath, JSON.stringify(SAMPLE_RESULT), "utf8");
    await writeFile(reportOutPath, "# SYNC-02 테스트 보고서", "utf8");
    return { stdout: "", stderr: "" };
  }) as any;
}

describe("runDailySaveCollector", () => {
  it("propagates a clear error when the child process fails or times out", async () => {
    const failingExecFileImpl = (async () => {
      throw new Error("collector exited with code 1 (simulated failure/timeout)");
    }) as any;
    await expect(
      runDailySaveCollector(
        { repoRoot: "/fake/repo", paperclipSnapshot: {} },
        { execFileImpl: failingExecFileImpl },
      ),
    ).rejects.toThrow();
  });

  it("propagates a clear error when the collector writes invalid JSON", async () => {
    const badJsonExecFileImpl = (async (_cmd: string, args: readonly string[]) => {
      const jsonOutPath = args[args.indexOf("--json-out") + 1] as string;
      const reportOutPath = args[args.indexOf("--report-out") + 1] as string;
      await writeFile(jsonOutPath, "not valid json", "utf8");
      await writeFile(reportOutPath, "ok", "utf8");
      return { stdout: "", stderr: "" };
    }) as any;
    await expect(
      runDailySaveCollector(
        { repoRoot: "/fake/repo", paperclipSnapshot: {} },
        { execFileImpl: badJsonExecFileImpl },
      ),
    ).rejects.toThrow();
  });


  it("writes the snapshot, runs the collector CLI, and returns the parsed classification result", async () => {
    const { result, reportMarkdown } = await runDailySaveCollector(
      { repoRoot: "/fake/repo", paperclipSnapshot: { agents: [], issues: [] } },
      { execFileImpl: makeOkExecFileImpl() },
    );
    expect(result.kstWindow.dateKst).toBe("2026-11-02");
    expect(result.summaryCounts.saveCandidateCount).toBe(1);
    expect(result.summaryCounts.needsReviewCount).toBe(2);
    expect(result.summaryCounts.excludedCount).toBe(3);
    expect((result as any).classifications.saveCandidates).toHaveLength(1);
    expect((result as any).classifications.needsReview).toHaveLength(2);
    expect((result as any).classifications.excluded).toHaveLength(3);
    expect(reportMarkdown).toBe("# SYNC-02 테스트 보고서");
  });

  it("cleans up its temp working directory after a successful run", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const before = new Set(await fs.readdir(os.tmpdir()));
    await runDailySaveCollector(
      { repoRoot: "/fake/repo", paperclipSnapshot: {} },
      { execFileImpl: makeOkExecFileImpl() },
    );
    const after = await fs.readdir(os.tmpdir());
    const leaked = after.filter((name) => name.startsWith("sync02-daily-save-") && !before.has(name));
    expect(leaked).toEqual([]);
  });

  it("cleans up its temp working directory even when the child process fails", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const before = new Set(await fs.readdir(os.tmpdir()));
    await expect(
      runDailySaveCollector(
        { repoRoot: "/fake/repo", paperclipSnapshot: {} },
        { execFileImpl: (async () => { throw new Error("boom"); }) as any },
      ),
    ).rejects.toThrow();
    const after = await fs.readdir(os.tmpdir());
    const leaked = after.filter((name) => name.startsWith("sync02-daily-save-") && !before.has(name));
    expect(leaked).toEqual([]);
  });
});

function fakeDbNoExistingApproval() {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  } as any;
}

describe("generateDailyGitSaveReportAndApproval", () => {
  it("creates a pending board approval carrying the classification report on success", async () => {
    mockApprovalsCreate.mockClear();
    const output = await generateDailyGitSaveReportAndApproval({
      db: fakeDbNoExistingApproval(),
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_on_demand_command",
      collectorDeps: { execFileImpl: makeOkExecFileImpl() },
    });
    expect(mockApprovalsCreate).toHaveBeenCalledTimes(1);
    const calledCompanyId = mockApprovalsCreate.mock.calls[0][0];
    const calledData = mockApprovalsCreate.mock.calls[0][1];
    expect(calledCompanyId).toBe("company-1");
    expect(calledData.status).toBe("pending");
    expect(calledData.payload.summaryCounts.saveCandidateCount).toBe(1);
    expect(output.approvalId).toBe("approval-1");
    expect(output.reportMarkdown).toBe("# SYNC-02 테스트 보고서");
  });

  it("never creates an approval when the collector fails", async () => {
    mockApprovalsCreate.mockClear();
    const failingExecFileImpl = (async () => {
      throw new Error("collector exited with code 1");
    }) as any;
    await expect(
      generateDailyGitSaveReportAndApproval({
        db: fakeDbNoExistingApproval(),
        companyId: "company-1",
        jarvisAgentId: "jarvis-agent-1",
        repoRoot: "/fake/repo",
        source: "sync02_on_demand_command",
        collectorDeps: { execFileImpl: failingExecFileImpl },
      }),
    ).rejects.toThrow();
    expect(mockApprovalsCreate).not.toHaveBeenCalled();
  });
});

function fakeDbWithExistingRow(row: any) {
  return {
    select: () => ({
      from: (table: any) => ({
        where: () => Promise.resolve(table === approvals ? [row] : []),
      }),
    }),
  } as any;
}

describe("generateDailyGitSaveReportAndApproval dedup", () => {
  it("reuses an existing same-day daily-reminder approval instead of running the collector again", async () => {
    mockApprovalsCreate.mockClear();
    let collectorCalled = false;
    const existingRow = {
      id: "existing-approval-1",
      payload: { dateKst: "2026-11-02", reportMarkdown: "existing report", summaryCounts: { saveCandidateCount: 9 } },
    };
    const output = await generateDailyGitSaveReportAndApproval({
      db: fakeDbWithExistingRow(existingRow),
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_daily_reminder",
      now: () => new Date("2026-11-02T03:00:00.000Z"),
      collectorDeps: { execFileImpl: (async () => { collectorCalled = true; throw new Error("must not run"); }) as any },
    });
    expect(collectorCalled).toBe(false);
    expect(mockApprovalsCreate).not.toHaveBeenCalled();
    expect(output.approvalId).toBe("existing-approval-1");
    expect(output.result.summaryCounts.saveCandidateCount).toBe(9);
  });

  it("always generates a fresh report for the on-demand command, ignoring any existing daily-reminder approval", async () => {
    mockApprovalsCreate.mockClear();
    const existingRow = { id: "existing-approval-1", payload: { dateKst: "2026-11-02" } };
    const output = await generateDailyGitSaveReportAndApproval({
      db: fakeDbWithExistingRow(existingRow),
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_on_demand_command",
      collectorDeps: { execFileImpl: makeOkExecFileImpl() },
    });
    expect(mockApprovalsCreate).toHaveBeenCalledTimes(1);
    expect(output.approvalId).toBe("approval-1");
  });
});

/**
 * Supports db.transaction(cb) (calls cb with a fresh tx-like object sharing
 * the same call counters), tx.execute() (the advisory-lock no-op), and the
 * exact .from(table)... chain shapes computeCompanyActivitySignal and
 * findExistingIdleReminderApproval each use. approvalRowsBySequence lets a
 * test give the 1st and 2nd .from(approvals) query different answers (early
 * vs. late dedup check); the last entry repeats for any further call.
 */
function createIdleFakeDb(options: {
  approvalRowsBySequence?: any[][];
  activeRuns?: any[];
  activeWakeups?: any[];
  latestProgressRows?: any[];
}) {
  let approvalsCallIndex = 0;
  let heartbeatRunsCallCount = 0;
  const makeDbLike = (): any => ({
    select: () => ({
      from: (table: any) => {
        if (table === approvals) {
          const sequence = options.approvalRowsBySequence ?? [[]];
          const rows = sequence[Math.min(approvalsCallIndex, sequence.length - 1)];
          approvalsCallIndex += 1;
          return { where: () => Promise.resolve(rows) };
        }
        if (table === heartbeatRuns) {
          heartbeatRunsCallCount += 1;
          if (heartbeatRunsCallCount % 2 === 1) {
            return { where: () => ({ limit: () => Promise.resolve(options.activeRuns ?? []) }) };
          }
          return {
            where: () => ({
              orderBy: () => ({ limit: () => Promise.resolve(options.latestProgressRows ?? []) }),
            }),
          };
        }
        if (table === agentWakeupRequests) {
          return { where: () => ({ limit: () => Promise.resolve(options.activeWakeups ?? []) }) };
        }
        return { where: () => Promise.resolve([]) };
      },
    }),
    execute: () => Promise.resolve(),
    transaction: async (cb: (tx: any) => unknown) => cb(makeDbLike()),
  });
  return makeDbLike();
}

describe("generateDailyGitSaveReportAndApproval idle-triggered (Stage A)", () => {
  const idleSinceAt = new Date("2026-11-02T02:00:00.000Z");
  const nowFn = () => new Date("2026-11-02T02:35:00.000Z"); // 35 minutes past idleSinceAt

  it("throws when idleSinceAt is missing for source sync02_idle_30min", async () => {
    mockApprovalsCreate.mockClear();
    await expect(
      generateDailyGitSaveReportAndApproval({
        db: createIdleFakeDb({}),
        companyId: "company-1",
        jarvisAgentId: "jarvis-agent-1",
        repoRoot: "/fake/repo",
        source: "sync02_idle_30min",
        now: nowFn,
        collectorDeps: { execFileImpl: makeOkExecFileImpl() },
      }),
    ).rejects.toThrow(/idleSinceAt is required/);
    expect(mockApprovalsCreate).not.toHaveBeenCalled();
  });

  it("creates a fresh approval with outcome 'created' when nothing is deduped and activity is still idle at the same anchor", async () => {
    mockApprovalsCreate.mockClear();
    const db = createIdleFakeDb({
      approvalRowsBySequence: [[], []],
      latestProgressRows: [{ lastUsefulActionAt: idleSinceAt }],
    });
    const output = await generateDailyGitSaveReportAndApproval({
      db,
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_idle_30min",
      idleSinceAt,
      now: nowFn,
      collectorDeps: { execFileImpl: makeOkExecFileImpl() },
    });
    expect(output.outcome).toBe("created");
    expect(mockApprovalsCreate).toHaveBeenCalledTimes(1);
    const calledData = mockApprovalsCreate.mock.calls[0][1];
    expect(calledData.payload.source).toBe("sync02_idle_30min");
    expect(calledData.payload.idleSinceAt).toBe(idleSinceAt.toISOString());
  });

  it("returns outcome 'deduplicated' and never runs the collector when an idle approval already exists for this idleSinceAt", async () => {
    mockApprovalsCreate.mockClear();
    let collectorCalled = false;
    const existingRow = {
      id: "existing-idle-1",
      payload: {
        source: "sync02_idle_30min",
        idleSinceAt: idleSinceAt.toISOString(),
        dateKst: "2026-11-02",
        reportMarkdown: "existing idle report",
        summaryCounts: { saveCandidateCount: 3 },
        readyForPrepare: true,
      },
    };
    const db = createIdleFakeDb({ approvalRowsBySequence: [[existingRow]] });
    const output = await generateDailyGitSaveReportAndApproval({
      db,
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_idle_30min",
      idleSinceAt,
      now: nowFn,
      collectorDeps: { execFileImpl: (async () => { collectorCalled = true; throw new Error("must not run"); }) as any },
    });
    expect(collectorCalled).toBe(false);
    expect(mockApprovalsCreate).not.toHaveBeenCalled();
    expect(output.outcome).toBe("deduplicated");
    expect(output.approvalId).toBe("existing-idle-1");
    expect(output.result.summaryCounts.saveCandidateCount).toBe(3);
  });

  it("prevents duplicate approvals when two concurrent requests race for the same company and idleSinceAt (existing dedup + advisory lock)", async () => {
    mockApprovalsCreate.mockClear();
    const lateExistingRow = {
      id: "existing-idle-from-other-instance",
      payload: { source: "sync02_idle_30min", idleSinceAt: idleSinceAt.toISOString(), dateKst: "2026-11-02", reportMarkdown: "", summaryCounts: {} },
    };
    const db = createIdleFakeDb({
      approvalRowsBySequence: [[], [lateExistingRow]],
      latestProgressRows: [{ lastUsefulActionAt: idleSinceAt }],
    });
    const output = await generateDailyGitSaveReportAndApproval({
      db,
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_idle_30min",
      idleSinceAt,
      now: nowFn,
      collectorDeps: { execFileImpl: makeOkExecFileImpl() },
    });
    expect(output.outcome).toBe("deduplicated");
    expect(output.approvalId).toBe("existing-idle-from-other-instance");
    expect(mockApprovalsCreate).not.toHaveBeenCalled();
  });

  it("cancels report generation when AI employee activity resumes right before the approval would be created", async () => {
    mockApprovalsCreate.mockClear();
    const db = createIdleFakeDb({
      approvalRowsBySequence: [[], []],
      activeRuns: [{ id: "just-started-run" }],
    });
    const output = await generateDailyGitSaveReportAndApproval({
      db,
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_idle_30min",
      idleSinceAt,
      now: nowFn,
      collectorDeps: { execFileImpl: makeOkExecFileImpl() },
    });
    expect(output.outcome).toBe("aborted_activity_resumed");
    expect(output.approvalId).toBeNull();
    expect(mockApprovalsCreate).not.toHaveBeenCalled();
  });

  it("leaves the daily-reminder and on-demand-command return shapes unaffected -- no 'outcome' field appears for either", async () => {
    mockApprovalsCreate.mockClear();

    const existingDailyRow = { id: "existing-daily-1", payload: { dateKst: "2026-11-02" } };
    const dailyDedupOutput = await generateDailyGitSaveReportAndApproval({
      db: fakeDbWithExistingRow(existingDailyRow),
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_daily_reminder",
      now: () => new Date("2026-11-02T03:00:00.000Z"),
      collectorDeps: { execFileImpl: (async () => { throw new Error("must not run"); }) as any },
    });
    expect(dailyDedupOutput.outcome).toBeUndefined();

    mockApprovalsCreate.mockClear();
    const dailyFreshOutput = await generateDailyGitSaveReportAndApproval({
      db: fakeDbNoExistingApproval(),
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_daily_reminder",
      now: () => new Date("2026-11-02T12:00:00.000Z"),
      collectorDeps: { execFileImpl: makeOkExecFileImpl() },
    });
    expect(dailyFreshOutput.outcome).toBeUndefined();

    mockApprovalsCreate.mockClear();
    const onDemandOutput = await generateDailyGitSaveReportAndApproval({
      db: fakeDbNoExistingApproval(),
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_on_demand_command",
      collectorDeps: { execFileImpl: makeOkExecFileImpl() },
    });
    expect(onDemandOutput.outcome).toBeUndefined();
  });
});

describe("generateDailyGitSaveReportAndApproval agent identity security checks", () => {
  it("rejects and creates no approval when jarvisAgentId does not exist", async () => {
    mockApprovalsCreate.mockClear();
    mockGetAgentByIdForDelegation.mockResolvedValueOnce(null);

    await expect(
      generateDailyGitSaveReportAndApproval({
        db: fakeDbNoExistingApproval(),
        companyId: "company-1",
        jarvisAgentId: "does-not-exist",
        repoRoot: "/fake/repo",
        source: "sync02_on_demand_command",
        collectorDeps: { execFileImpl: makeOkExecFileImpl() },
      }),
    ).rejects.toThrow(/no agent found/);
    expect(mockApprovalsCreate).not.toHaveBeenCalled();
  });

  it("rejects and creates no approval when jarvisAgentId belongs to a different company", async () => {
    mockApprovalsCreate.mockClear();
    mockGetAgentByIdForDelegation.mockResolvedValueOnce({ id: "jarvis-other", companyId: "company-OTHER" });

    await expect(
      generateDailyGitSaveReportAndApproval({
        db: fakeDbNoExistingApproval(),
        companyId: "company-1",
        jarvisAgentId: "jarvis-other",
        repoRoot: "/fake/repo",
        source: "sync02_on_demand_command",
        collectorDeps: { execFileImpl: makeOkExecFileImpl() },
      }),
    ).rejects.toThrow(/not the requested company/);
    expect(mockApprovalsCreate).not.toHaveBeenCalled();
  });

  it("proceeds normally when jarvisAgentId exists and belongs to the requested company", async () => {
    mockApprovalsCreate.mockClear();
    mockGetAgentByIdForDelegation.mockResolvedValueOnce({ id: "jarvis-agent-1", companyId: "company-1" });

    const output = await generateDailyGitSaveReportAndApproval({
      db: fakeDbNoExistingApproval(),
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent-1",
      repoRoot: "/fake/repo",
      source: "sync02_on_demand_command",
      collectorDeps: { execFileImpl: makeOkExecFileImpl() },
    });
    expect(mockApprovalsCreate).toHaveBeenCalledTimes(1);
    expect(output.approvalId).toBe("approval-1");
  });
});

describe("buildPaperclipSnapshotForDailySave work products", () => {
  function fakeDbRows(agentRows: any[], issueRows: any[], workProductRows: any[]) {
    return {
      select: () => ({
        from: (table: any) => ({
          where: () => {
            if (table === agents) return Promise.resolve(agentRows);
            if (table === issues) return Promise.resolve(issueRows);
            if (table === issueWorkProducts) return Promise.resolve(workProductRows);
            return Promise.resolve([]);
          },
        }),
      }),
    } as any;
  }

  it("groups work products by issueId and passes through status/reviewState/metadata unchanged", async () => {
    const db = fakeDbRows(
      [],
      [
        {
          id: "issue-1",
          status: "done",
          title: "t",
          identifier: "I-1",
          assigneeAgentId: null,
          completedAt: new Date("2026-11-02T00:00:00.000Z"),
          updatedAt: new Date("2026-11-02T00:00:00.000Z"),
        },
      ],
      [
        { issueId: "issue-1", status: "approved", reviewState: "approved", metadata: { resourceRef: { path: "a.ts" } } },
        { issueId: "issue-1", status: "approved", reviewState: "approved", metadata: null },
        { issueId: "issue-2", status: "pending", reviewState: "none", metadata: null },
      ],
    );
    const snapshot = await buildPaperclipSnapshotForDailySave(db, "company-1");
    expect(snapshot.workProductsByIssueId["issue-1"]).toHaveLength(2);
    expect(snapshot.workProductsByIssueId["issue-1"][0]).toEqual({
      status: "approved",
      reviewState: "approved",
      metadata: { resourceRef: { path: "a.ts" } },
    });
    expect(snapshot.workProductsByIssueId["issue-2"]).toHaveLength(1);
    expect(snapshot.workProductsByIssueId["issue-2"][0].status).toBe("pending");
  });

  it("leaves workProductsByIssueId without an entry for a completed issue that has no work products at all", async () => {
    const db = fakeDbRows(
      [],
      [
        {
          id: "issue-3",
          status: "done",
          title: "t",
          identifier: "I-3",
          assigneeAgentId: null,
          completedAt: new Date("2026-11-02T00:00:00.000Z"),
          updatedAt: new Date("2026-11-02T00:00:00.000Z"),
        },
      ],
      [],
    );
    const snapshot = await buildPaperclipSnapshotForDailySave(db, "company-1");
    expect(snapshot.workProductsByIssueId["issue-3"]).toBeUndefined();
  });

  it("passes through a pending/unreviewed work product's real status instead of marking it approved", async () => {
    const db = fakeDbRows(
      [],
      [
        {
          id: "issue-4",
          status: "done",
          title: "t",
          identifier: "I-4",
          assigneeAgentId: null,
          completedAt: new Date("2026-11-02T00:00:00.000Z"),
          updatedAt: new Date("2026-11-02T00:00:00.000Z"),
        },
      ],
      [{ issueId: "issue-4", status: "pending", reviewState: "none", metadata: null }],
    );
    const snapshot = await buildPaperclipSnapshotForDailySave(db, "company-1");
    const wp = snapshot.workProductsByIssueId["issue-4"][0];
    expect(wp.status).not.toBe("approved");
    expect(wp.reviewState).not.toBe("approved");
  });

  it("propagates a work-product query failure instead of silently returning an empty snapshot", async () => {
    const failingDb = {
      select: () => ({
        from: (table: any) => ({
          where: () => {
            if (table === issueWorkProducts) return Promise.reject(new Error("db connection lost"));
            return Promise.resolve([]);
          },
        }),
      }),
    } as any;
    await expect(buildPaperclipSnapshotForDailySave(failingDb, "company-1")).rejects.toThrow(/db connection lost/);
  });
});
