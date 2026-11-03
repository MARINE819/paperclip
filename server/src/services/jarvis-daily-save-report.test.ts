import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { approvals } from "@paperclipai/db";

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
