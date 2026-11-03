import { describe, expect, it, vi } from "vitest";

const mockGenerate = vi.hoisted(() =>
  vi.fn(async (_args: any): Promise<any> => ({ approvalId: "approval-1" })),
);
vi.mock("./jarvis-daily-save-report.js", () => ({
  generateDailyGitSaveReportAndApproval: mockGenerate,
}));

import { handleJarvisCommandText } from "./jarvis-daily-save-command-router.js";

describe("handleJarvisCommandText", () => {
  it("recognizes the exact 저장하자 command and delegates to the report generator", async () => {
    mockGenerate.mockClear();
    const result = await handleJarvisCommandText({
      db: {} as any,
      companyId: "company-1",
      jarvisAgentId: "jarvis-1",
      repoRoot: "/fake/repo",
      requestText: "저장하자",
    });
    expect(result.matched).toBe(true);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith({
      db: {},
      companyId: "company-1",
      jarvisAgentId: "jarvis-1",
      repoRoot: "/fake/repo",
      source: "sync02_on_demand_command",
    });
  });

  it("leaves ordinary request text unmatched so the existing delegation flow still runs it", async () => {
    mockGenerate.mockClear();
    const result = await handleJarvisCommandText({
      db: {} as any,
      companyId: "company-1",
      jarvisAgentId: "jarvis-1",
      repoRoot: "/fake/repo",
      requestText: "Fix the flaky login test",
    });
    expect(result.matched).toBe(false);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("propagates a cross-company/invalid-agent rejection instead of swallowing it, and never reports matched:false", async () => {
    mockGenerate.mockClear();
    mockGenerate.mockRejectedValueOnce(new Error("SYNC-02: agent jarvis-1 belongs to a different company"));
    await expect(
      handleJarvisCommandText({
        db: {} as any,
        companyId: "company-1",
        jarvisAgentId: "jarvis-1",
        repoRoot: "/fake/repo",
        requestText: "저장하자",
      }),
    ).rejects.toThrow(/different company/);
  });

  it("propagates a collector failure instead of swallowing it (no approval is ever created on failure)", async () => {
    mockGenerate.mockClear();
    mockGenerate.mockRejectedValueOnce(new Error("SYNC-02 daily save collector failed or timed out"));
    await expect(
      handleJarvisCommandText({
        db: {} as any,
        companyId: "company-1",
        jarvisAgentId: "jarvis-1",
        repoRoot: "/fake/repo",
        requestText: "저장하자",
      }),
    ).rejects.toThrow(/collector failed/);
  });

  it("always dispatches a repeated manual command with source sync02_on_demand_command (current no-dedup policy for this entry point)", async () => {
    mockGenerate.mockClear();
    mockGenerate.mockResolvedValueOnce({ approvalId: "approval-1" } as any);
    mockGenerate.mockResolvedValueOnce({ approvalId: "approval-2" } as any);

    const input = {
      db: {} as any,
      companyId: "company-1",
      jarvisAgentId: "jarvis-1",
      repoRoot: "/fake/repo",
      requestText: "저장하자",
    };
    const first = await handleJarvisCommandText(input);
    const second = await handleJarvisCommandText(input);

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockGenerate.mock.calls[0][0].source).toBe("sync02_on_demand_command");
    expect(mockGenerate.mock.calls[1][0].source).toBe("sync02_on_demand_command");
    if (first.matched) expect(first.report.approvalId).toBe("approval-1");
    if (second.matched) expect(second.report.approvalId).toBe("approval-2");
  });
});
