import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

function fakeChild(stdoutChunks: string[], exitCode: number | null, delayMs = 0) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  setTimeout(() => {
    for (const chunk of stdoutChunks) child.stdout.emit("data", Buffer.from(chunk));
    child.emit("close", exitCode);
  }, delayMs);
  return child;
}

import {
  discoverRuntimeModels,
  discoverAntigravityModels,
  discoverHermesModels,
  discoverOpenCodeModels,
  clearRuntimeDiscoveryCacheForTests,
  type RuntimeDiscoveryResult,
} from "./runtime-model-discovery.js";

beforeEach(() => {
  mockSpawn.mockReset();
  clearRuntimeDiscoveryCacheForTests();
});

describe("discoverRuntimeModels — cache + timeout + fail-closed behavior", () => {
  it("caches a successful result and does not call the source again within the TTL", async () => {
    const source = vi.fn(async (): Promise<RuntimeDiscoveryResult> => ({ status: "ok", models: [{ model: "m1", provider: "p" }] }));
    const first = await discoverRuntimeModels("key-a", source, { ttlMs: 60_000 });
    const second = await discoverRuntimeModels("key-a", source, { ttlMs: 60_000 });
    expect(first.status).toBe("ok");
    expect(second).toEqual(first);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("never caches a failure — retries the source on the very next call", async () => {
    const source = vi.fn(async (): Promise<RuntimeDiscoveryResult> => ({ status: "error", models: [], errorMessage: "boom" }));
    await discoverRuntimeModels("key-b", source, { ttlMs: 60_000 });
    await discoverRuntimeModels("key-b", source, { ttlMs: 60_000 });
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("fails closed with status 'timeout' when the source never resolves within timeoutMs, even if the source ignores the abort signal entirely", async () => {
    const source = vi.fn(() => new Promise<RuntimeDiscoveryResult>(() => {})); // never settles, ignores signal
    const result = await discoverRuntimeModels("key-c", source, { timeoutMs: 20, ttlMs: 60_000 });
    expect(result.status).toBe("timeout");
    expect(result.models).toEqual([]);
  });

  it("fails closed with status 'error' (never throws) when the source itself throws", async () => {
    const source = vi.fn(async (): Promise<RuntimeDiscoveryResult> => {
      throw new Error("source exploded");
    });
    const result = await discoverRuntimeModels("key-d", source, { ttlMs: 60_000 });
    expect(result.status).toBe("error");
    expect(result.models).toEqual([]);
  });
});

describe("discoverAntigravityModels — parses `agy models` tab-separated output", () => {
  it("parses real-shaped multi-line output into (model, provider:'antigravity') pairs, skipping the 'Fetching...' line", async () => {
    mockSpawn.mockReturnValue(
      fakeChild(
        ["Fetching available models...\n", "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n", "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n"],
        0,
      ),
    );
    const controller = new AbortController();
    const result = await discoverAntigravityModels(controller.signal);
    expect(result.status).toBe("ok");
    expect(result.models).toEqual([
      { model: "gemini-3.8-flash-high", provider: "antigravity" },
      { model: "claude-sonnet-4-6", provider: "antigravity" },
    ]);
  });

  it("returns 'empty' for blank output", async () => {
    mockSpawn.mockReturnValue(fakeChild([""], 0));
    const result = await discoverAntigravityModels(new AbortController().signal);
    expect(result.status).toBe("empty");
  });

  it("returns 'error' for a non-zero exit code", async () => {
    mockSpawn.mockReturnValue(fakeChild(["some error"], 1));
    const result = await discoverAntigravityModels(new AbortController().signal);
    expect(result.status).toBe("error");
  });
});

describe("discoverHermesModels — parses `hermes status` Model: line", () => {
  it("parses a real-shaped status panel", async () => {
    mockSpawn.mockReturnValue(
      fakeChild(["◆ Environment\n  Model:        nvidia/nemotron-3-super-120b-a12b:free\n  Provider:     Custom endpoint\n"], 0),
    );
    const result = await discoverHermesModels(new AbortController().signal);
    expect(result.status).toBe("ok");
    expect(result.models).toEqual([{ model: "nvidia/nemotron-3-super-120b-a12b:free", provider: "hermes" }]);
  });

  it("returns 'malformed' when no Model: line is present (format drift) — never guesses", async () => {
    mockSpawn.mockReturnValue(fakeChild(["some totally different output\n"], 0));
    const result = await discoverHermesModels(new AbortController().signal);
    expect(result.status).toBe("malformed");
  });
});

describe("discoverOpenCodeModels — parses `opencode models` provider/model lines", () => {
  it("parses real-shaped free-tier output", async () => {
    mockSpawn.mockReturnValue(fakeChild(["opencode/big-pickle\nopencode/nemotron-3-ultra-free\n"], 0));
    const result = await discoverOpenCodeModels(new AbortController().signal);
    expect(result.status).toBe("ok");
    expect(result.models).toEqual([
      { model: "big-pickle", provider: "opencode" },
      { model: "nemotron-3-ultra-free", provider: "opencode" },
    ]);
  });

  it("returns 'empty' when no line contains a provider/model separator", async () => {
    mockSpawn.mockReturnValue(fakeChild(["no-slash-here\n"], 0));
    const result = await discoverOpenCodeModels(new AbortController().signal);
    expect(result.status).toBe("empty");
  });
});
