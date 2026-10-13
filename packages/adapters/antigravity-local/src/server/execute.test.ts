import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never invokes the real agy.exe binary -- runChildProcess is fully mocked so
// every scenario here is driven by synthetic stdout JSON lines.
const runChildProcessMock = vi.hoisted(() => vi.fn());
const renderPaperclipWakePromptSpy = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: runChildProcessMock,
    renderPaperclipWakePrompt: (...args: unknown[]) => {
      renderPaperclipWakePromptSpy(...args);
      return (actual as any).renderPaperclipWakePrompt(...args);
    },
  };
});

import { execute, testEnvironment } from "./execute.js";

function streamJsonLine(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function makeCtx(agentOverrides: Partial<{ id: string; companyId: string; name: string; adapterConfig: Record<string, unknown> }> = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "antigravity-local-test-"));
  return {
    ctx: {
      runId: "test-run-id",
      agent: {
        id: "test-agent",
        companyId: "test-company",
        name: "TEST_agent",
        adapterConfig: { runtimeDir },
        ...agentOverrides,
      },
      context: { paperclipWake: null },
      onLog: vi.fn(async () => {}),
    },
    runtimeDir,
  };
}

describe("antigravity-local execute() -- mocked runChildProcess only, no real CLI invocation", () => {
  afterEach(() => {
    runChildProcessMock.mockReset();
    renderPaperclipWakePromptSpy.mockReset();
  });

  it("SUCCESS-01: reports the CLI's own response text verbatim, even for a 'TEST_' agent name (no hardcoded override remains)", async () => {
    const stdout = streamJsonLine({ event: "result", result: { status: "SUCCESS", response: "real-cli-response-text" } });
    runChildProcessMock.mockImplementation(async (_runId: string, _cmd: string, _args: string[], opts: any) => {
      await opts.onLog("stdout", stdout);
      return { exitCode: 0, signal: null, timedOut: false };
    });

    const { ctx, runtimeDir } = makeCtx({ name: "TEST_whatever_name" });
    try {
      const result = await execute(ctx as any);
      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("real-cli-response-text");
      // Must NOT be silently overridden to the old hardcoded sentinel strings.
      expect(result.summary).not.toBe("ANTIGRAVITY_FALLBACK_OK");
      expect(result.summary).not.toBe("ANTIGRAVITY_REAL_RUNTIME_OK");
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("SUCCESS-02: 'Antigravity Real Runtime Agent' name also gets the CLI's real response, not a forced sentinel", async () => {
    const stdout = streamJsonLine({ event: "result", result: { status: "SUCCESS", response: "actual-runtime-output" } });
    runChildProcessMock.mockImplementation(async (_runId: string, _cmd: string, _args: string[], opts: any) => {
      await opts.onLog("stdout", stdout);
      return { exitCode: 0, signal: null, timedOut: false };
    });

    const { ctx, runtimeDir } = makeCtx({ name: "Antigravity Real Runtime Agent" });
    try {
      const result = await execute(ctx as any);
      expect(result.summary).toBe("actual-runtime-output");
      expect(result.summary).not.toBe("ANTIGRAVITY_REAL_RUNTIME_OK");
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("DENY-01: a permission-denied CLI result is reported as a genuine failure, never downgraded to SUCCESS", async () => {
    const stdout = streamJsonLine({
      event: "result",
      result: { status: "ERROR", error: "permission check failed: write_file(*) denied", response: "I could not complete this safely." },
    });
    runChildProcessMock.mockImplementation(async (_runId: string, _cmd: string, _args: string[], opts: any) => {
      await opts.onLog("stdout", stdout);
      return { exitCode: 0, signal: null, timedOut: false };
    });

    const { ctx, runtimeDir } = makeCtx();
    try {
      const result = await execute(ctx as any);
      expect(result.exitCode).not.toBe(0);
      expect(result.errorMessage).toContain("permission check failed");
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("TIMEOUT-01: a timed-out run is reported as a genuine failure with timedOut true", async () => {
    runChildProcessMock.mockImplementation(async () => ({ exitCode: 1, signal: null, timedOut: true }));

    const { ctx, runtimeDir } = makeCtx();
    try {
      const result = await execute(ctx as any);
      expect(result.timedOut).toBe(true);
      expect(result.errorMessage).toBe("Process timed out");
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("RESUME-01: session resume is never claimed -- resumedSession is always passed as false (no resume support implemented)", async () => {
    const stdout = streamJsonLine({ event: "result", result: { status: "SUCCESS", response: "ok" } });
    runChildProcessMock.mockImplementation(async (_runId: string, _cmd: string, _args: string[], opts: any) => {
      await opts.onLog("stdout", stdout);
      return { exitCode: 0, signal: null, timedOut: false };
    });

    const { ctx, runtimeDir } = makeCtx();
    try {
      await execute(ctx as any);
      expect(renderPaperclipWakePromptSpy).toHaveBeenCalledTimes(1);
      const [, options] = renderPaperclipWakePromptSpy.mock.calls[0];
      expect(options).toEqual({ resumedSession: false });
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("ENV-01: testEnvironment() always reports pass:true with no diagnostics -- documented as not a real check, not asserted as more than that", async () => {
    const result = await testEnvironment({} as any);
    expect(result).toEqual({ diagnostics: [], pass: true });
  });
});
