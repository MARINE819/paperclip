import { describe, expect, it, vi } from "vitest";

const mockGenerateDailySaveReport = vi.hoisted(() => vi.fn());
vi.mock("./jarvis-daily-save-report.js", () => ({
  generateDailyGitSaveReportAndApproval: mockGenerateDailySaveReport,
}));

import {
  isWithinKstReminderHour,
  runGitSaveDailyReminderTick,
  createGitSaveDailyReminderScheduler,
} from "./git-save-daily-reminder-scheduler.js";

describe("isWithinKstReminderHour", () => {
  it("is true at 21:00-21:59 KST", () => {
    expect(isWithinKstReminderHour(new Date("2026-11-02T12:00:00.000Z"))).toBe(true);
  });

  it("is false outside the 21:00 KST hour", () => {
    expect(isWithinKstReminderHour(new Date("2026-11-02T10:00:00.000Z"))).toBe(false);
  });
});

describe("runGitSaveDailyReminderTick", () => {
  it("skips entirely outside the KST 21:00 hour, never querying companies", async () => {
    const dbSpy = { select: vi.fn() } as any;
    const result = await runGitSaveDailyReminderTick({
      db: dbSpy,
      repoRoot: "/fake/repo",
      now: () => new Date("2026-11-02T10:00:00.000Z"),
    });
    expect(result.skipped).toBe(true);
    expect(dbSpy.select).not.toHaveBeenCalled();
    expect(mockGenerateDailySaveReport).not.toHaveBeenCalled();
  });

  it("within the 21:00 KST hour, finds each company's JARVIS agent and isolates per-company errors", async () => {
    mockGenerateDailySaveReport.mockReset();
    mockGenerateDailySaveReport
      .mockResolvedValueOnce({ approvalId: "approval-ok", dateKst: "2026-11-02", reportMarkdown: "ok", result: {} as any })
      .mockRejectedValueOnce(new Error("collector failed for company-2"));

    const { companies } = await import("@paperclipai/db");
    const companyRows = [{ id: "company-1" }, { id: "company-2" }, { id: "company-no-jarvis" }];
    let agentCallIndex = 0;

    const dbSpy = {
      select: () => ({
        from: (table: any) => {
          // Matches the real implementation exactly: the companies query is
          // `await db.select(...).from(companies)` with NO `.where()`, so
          // `.from()` itself must resolve to the row array here. Only the
          // agents lookup chains `.where(...)`.
          if (table === companies) {
            return Promise.resolve(companyRows);
          }
          return {
            where: () => {
              const companyId = companyRows[agentCallIndex]?.id;
              agentCallIndex += 1;
              if (companyId === "company-no-jarvis") return Promise.resolve([]);
              return Promise.resolve([{ id: `jarvis-${companyId}` }]);
            },
          };
        },
      }),
    } as any;

    const result = await runGitSaveDailyReminderTick({
      db: dbSpy,
      repoRoot: "/fake/repo",
      now: () => new Date("2026-11-02T12:00:00.000Z"),
    });

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("unreachable");
    expect(result.perCompany).toHaveLength(3);
    expect(result.perCompany.find((r) => r.companyId === "company-no-jarvis")?.skipped).toBe("no_jarvis_agent");
    expect(result.perCompany.find((r) => r.companyId === "company-1")?.approvalId).toBe("approval-ok");
    expect(result.perCompany.find((r) => r.companyId === "company-2")?.error).toContain("collector failed");
    expect(mockGenerateDailySaveReport).toHaveBeenCalledTimes(2);
  });
});
