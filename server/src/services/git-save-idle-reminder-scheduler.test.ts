import { describe, expect, it, vi } from "vitest";

const mockGenerateReport = vi.hoisted(() => vi.fn());
vi.mock("./jarvis-daily-save-report.js", () => ({
  generateDailyGitSaveReportAndApproval: mockGenerateReport,
}));

const mockComputeCompanyActivitySignal = vi.hoisted(() => vi.fn());
vi.mock("./jarvis-idle-activity-detector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jarvis-idle-activity-detector.js")>();
  return { ...actual, computeCompanyActivitySignal: mockComputeCompanyActivitySignal };
});

import { runGitSaveIdleReminderTick } from "./git-save-idle-reminder-scheduler.js";

describe("runGitSaveIdleReminderTick", () => {
  it("skips a company that is active, without calling the report generator", async () => {
    mockGenerateReport.mockClear();
    mockComputeCompanyActivitySignal.mockReset();
    mockComputeCompanyActivitySignal.mockResolvedValue({ state: "active", reason: "a heartbeat run is queued or running" });

    const { companies } = await import("@paperclipai/db");
    const companyRows = [{ id: "company-1" }];
    const dbSpy = {
      select: () => ({
        from: (table: any) => (table === companies ? Promise.resolve(companyRows) : { where: () => Promise.resolve([]) }),
      }),
    } as any;

    const result = await runGitSaveIdleReminderTick({
      db: dbSpy,
      repoRoot: "/fake/repo",
      now: () => new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(result.perCompany).toHaveLength(1);
    expect(result.perCompany[0].skipped).toBe("active");
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it("skips a company whose activity state is unknown, without calling the report generator", async () => {
    mockGenerateReport.mockClear();
    mockComputeCompanyActivitySignal.mockReset();
    mockComputeCompanyActivitySignal.mockResolvedValue({ state: "unknown", reason: "no run with recorded concrete progress evidence yet" });

    const { companies } = await import("@paperclipai/db");
    const companyRows = [{ id: "company-1" }];
    const dbSpy = {
      select: () => ({
        from: (table: any) => (table === companies ? Promise.resolve(companyRows) : { where: () => Promise.resolve([]) }),
      }),
    } as any;

    const result = await runGitSaveIdleReminderTick({
      db: dbSpy,
      repoRoot: "/fake/repo",
      now: () => new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(result.perCompany[0].skipped).toBe("unknown");
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it("skips a company idle for less than 30 minutes", async () => {
    mockGenerateReport.mockClear();
    mockComputeCompanyActivitySignal.mockReset();
    const idleSinceAt = new Date("2026-11-02T11:45:00.000Z"); // 15 minutes before `now`
    mockComputeCompanyActivitySignal.mockResolvedValue({ state: "idle_since", idleSinceAt });

    const { companies } = await import("@paperclipai/db");
    const companyRows = [{ id: "company-1" }];
    const dbSpy = {
      select: () => ({
        from: (table: any) => (table === companies ? Promise.resolve(companyRows) : { where: () => Promise.resolve([]) }),
      }),
    } as any;

    const result = await runGitSaveIdleReminderTick({
      db: dbSpy,
      repoRoot: "/fake/repo",
      now: () => new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(result.perCompany[0].skipped).toBe("idle_below_threshold");
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it("calls the report generator with the exact companyId and idleSinceAt when idle for 30+ minutes and JARVIS exists", async () => {
    mockGenerateReport.mockClear();
    mockGenerateReport.mockResolvedValueOnce({
      approvalId: "approval-1",
      dateKst: "2026-11-02",
      reportMarkdown: "ok",
      result: {} as any,
      outcome: "created",
    });
    mockComputeCompanyActivitySignal.mockReset();
    const idleSinceAt = new Date("2026-11-02T11:30:00.000Z"); // exactly 30 minutes before `now`
    mockComputeCompanyActivitySignal.mockResolvedValue({ state: "idle_since", idleSinceAt });

    const { companies } = await import("@paperclipai/db");
    const companyRows = [{ id: "company-1" }];
    const dbSpy = {
      select: () => ({
        from: (table: any) =>
          table === companies
            ? Promise.resolve(companyRows)
            : { where: () => Promise.resolve([{ id: "jarvis-company-1" }]) },
      }),
    } as any;

    const result = await runGitSaveIdleReminderTick({
      db: dbSpy,
      repoRoot: "/fake/repo",
      now: () => new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(mockGenerateReport).toHaveBeenCalledTimes(1);
    const calledArgs = mockGenerateReport.mock.calls[0][0];
    expect(calledArgs.companyId).toBe("company-1");
    expect(calledArgs.jarvisAgentId).toBe("jarvis-company-1");
    expect(calledArgs.source).toBe("sync02_idle_30min");
    expect(calledArgs.idleSinceAt).toBe(idleSinceAt);
    expect(result.perCompany[0].approvalId).toBe("approval-1");
    expect(result.perCompany[0].outcome).toBe("created");
  });

  it("skips a company idle for 30+ minutes with no JARVIS agent", async () => {
    mockGenerateReport.mockClear();
    mockComputeCompanyActivitySignal.mockReset();
    mockComputeCompanyActivitySignal.mockResolvedValue({
      state: "idle_since",
      idleSinceAt: new Date("2026-11-02T11:00:00.000Z"),
    });

    const { companies } = await import("@paperclipai/db");
    const companyRows = [{ id: "company-no-jarvis" }];
    const dbSpy = {
      select: () => ({
        from: (table: any) => (table === companies ? Promise.resolve(companyRows) : { where: () => Promise.resolve([]) }),
      }),
    } as any;

    const result = await runGitSaveIdleReminderTick({
      db: dbSpy,
      repoRoot: "/fake/repo",
      now: () => new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(result.perCompany[0].skipped).toBe("no_jarvis_agent");
    expect(mockGenerateReport).not.toHaveBeenCalled();
  });

  it("isolates a per-company error (e.g. the report generator throwing) without stopping the remaining companies", async () => {
    mockGenerateReport.mockReset();
    mockGenerateReport
      .mockRejectedValueOnce(new Error("collector failed for company-1"))
      .mockResolvedValueOnce({
        approvalId: "approval-2",
        dateKst: "2026-11-02",
        reportMarkdown: "ok",
        result: {} as any,
        outcome: "created",
      });
    mockComputeCompanyActivitySignal.mockReset();
    mockComputeCompanyActivitySignal.mockResolvedValue({
      state: "idle_since",
      idleSinceAt: new Date("2026-11-02T11:00:00.000Z"),
    });

    const { companies } = await import("@paperclipai/db");
    const companyRows = [{ id: "company-1" }, { id: "company-2" }];
    let agentCallIndex = 0;
    const dbSpy = {
      select: () => ({
        from: (table: any) => {
          if (table === companies) return Promise.resolve(companyRows);
          return {
            where: () => {
              const companyId = companyRows[agentCallIndex]?.id;
              agentCallIndex += 1;
              return Promise.resolve([{ id: `jarvis-${companyId}` }]);
            },
          };
        },
      }),
    } as any;

    const result = await runGitSaveIdleReminderTick({
      db: dbSpy,
      repoRoot: "/fake/repo",
      now: () => new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(result.perCompany).toHaveLength(2);
    expect(result.perCompany.find((r) => r.companyId === "company-1")?.error).toContain("collector failed");
    expect(result.perCompany.find((r) => r.companyId === "company-2")?.approvalId).toBe("approval-2");
    expect(mockGenerateReport).toHaveBeenCalledTimes(2);
  });

  it("passes through generateDailyGitSaveReportAndApproval's own 'deduplicated' outcome unchanged (dedup logic itself lives there, not re-implemented here)", async () => {
    mockGenerateReport.mockClear();
    mockGenerateReport.mockResolvedValueOnce({
      approvalId: "existing-idle-1",
      dateKst: "2026-11-02",
      reportMarkdown: "existing",
      result: {} as any,
      outcome: "deduplicated",
    });
    mockComputeCompanyActivitySignal.mockReset();
    const idleSinceAt = new Date("2026-11-02T11:00:00.000Z");
    mockComputeCompanyActivitySignal.mockResolvedValue({ state: "idle_since", idleSinceAt });

    const { companies } = await import("@paperclipai/db");
    const companyRows = [{ id: "company-1" }];
    const dbSpy = {
      select: () => ({
        from: (table: any) =>
          table === companies
            ? Promise.resolve(companyRows)
            : { where: () => Promise.resolve([{ id: "jarvis-company-1" }]) },
      }),
    } as any;

    const result = await runGitSaveIdleReminderTick({
      db: dbSpy,
      repoRoot: "/fake/repo",
      now: () => new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(result.perCompany[0].outcome).toBe("deduplicated");
    expect(result.perCompany[0].approvalId).toBe("existing-idle-1");
  });
});
