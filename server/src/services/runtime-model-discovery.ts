// NEXORA Intelligent Execution Router — Runtime Model Discovery.
// For executors whose provider/model is genuinely pluggable at runtime
// (antigravity_local, hermes_local, opencode_local) rather than a fixed
// row in model-registry.ts's static MODEL_REGISTRY. Each source shells out
// to that executor's own CLI to ask it directly, with a bounded timeout, a
// short TTL cache (so a dynamic dispatch doesn't pay this cost on every
// single run), and fail-closed behavior on any timeout/error/malformed
// output — never a thrown exception reaching the caller, never a silently
// invented model.

import { spawn } from "node:child_process";

export interface RuntimeDiscoveredModel {
  model: string;
  provider: string | null;
}

export type RuntimeDiscoveryStatus = "ok" | "timeout" | "empty" | "malformed" | "error";

export interface RuntimeDiscoveryResult {
  status: RuntimeDiscoveryStatus;
  models: readonly RuntimeDiscoveredModel[];
  errorMessage?: string;
}

// `command` lets a caller override the bare CLI name with a machine-local
// absolute path (see ExecutorRecord.binaryPath in executor-registry.ts) for
// an executor whose binary is not reliably on PATH in this environment.
// Sources that have no such concern (every one except opencode_local today)
// simply ignore it.
export type RuntimeDiscoverySource = (signal: AbortSignal, command?: string) => Promise<RuntimeDiscoveryResult>;

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

interface CacheEntry {
  result: RuntimeDiscoveryResult;
  expiresAt: number;
}

const DISCOVERY_CACHE = new Map<string, CacheEntry>();

// Test-only seam — production code never calls this.
export function clearRuntimeDiscoveryCacheForTests(): void {
  DISCOVERY_CACHE.clear();
}

export async function discoverRuntimeModels(
  cacheKey: string,
  source: RuntimeDiscoverySource,
  opts?: { ttlMs?: number; timeoutMs?: number },
): Promise<RuntimeDiscoveryResult> {
  const now = Date.now();
  const cached = DISCOVERY_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const controller = new AbortController();

  // Self-enforced via Promise.race rather than relying on `source` to
  // cooperate with the abort signal — bounded timeout is guaranteed
  // regardless of the source implementation. The signal is still passed
  // through so a well-behaved source (every real one here uses it via
  // node:child_process's spawn({signal}) option) can promptly kill any
  // underlying process instead of leaving it orphaned in the background.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<RuntimeDiscoveryResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: "timeout", models: [], errorMessage: `discovery exceeded ${timeoutMs}ms` });
    }, timeoutMs);
  });

  let result: RuntimeDiscoveryResult;
  try {
    result = await Promise.race([source(controller.signal), timeoutPromise]);
  } catch (err) {
    result = { status: "error", models: [], errorMessage: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }

  // Never cache a failure — a transient timeout/error should not pin the
  // executor as unusable for the full TTL window; a success result is
  // cached, a failure is retried on the very next call.
  if (result.status === "ok" && result.models.length > 0) {
    DISCOVERY_CACHE.set(cacheKey, { result, expiresAt: now + ttlMs });
  }
  return result;
}

function runCommandAndCapture(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal, windowsHide: true });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (exitCode) => resolve({ stdout, exitCode }));
  });
}

// `agy models` prints one "<model-id>\t<label>" line per model, e.g.
// "gemini-3.8-flash-high\tGemini 3.8 Flash (High)" — confirmed by direct
// invocation 2026-10-03. No single fixed provider: antigravity proxies its
// own hosted backend, so provider is reported as "antigravity" rather than
// guessing a vendor from the model name.
export async function discoverAntigravityModels(signal: AbortSignal, _command?: string): Promise<RuntimeDiscoveryResult> {
  try {
    const { stdout, exitCode } = await runCommandAndCapture("agy", ["models"], signal);
    if (exitCode !== 0) {
      return { status: "error", models: [], errorMessage: `agy models exited ${exitCode}` };
    }
    const models = stdout
      .split(/\r?\n/)
      .map((line) => line.split("\t")[0]?.trim())
      .filter((id): id is string => Boolean(id) && !id.startsWith("Fetching"))
      .map((model) => ({ model, provider: "antigravity" }));
    if (models.length === 0) return { status: "empty", models: [] };
    return { status: "ok", models };
  } catch (err) {
    return { status: "error", models: [], errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

// `hermes status` prints a human-readable panel including a "Model:" and
// "Provider:" line — confirmed by direct invocation 2026-10-03
// ("Model: nvidia/nemotron-3-super-120b-a12b:free", "Provider: Custom
// endpoint"). Parsed defensively — any format drift fails closed to
// "malformed" rather than guessing.
export async function discoverHermesModels(signal: AbortSignal, _command?: string): Promise<RuntimeDiscoveryResult> {
  try {
    const { stdout, exitCode } = await runCommandAndCapture("hermes", ["status"], signal);
    if (exitCode !== 0) {
      return { status: "error", models: [], errorMessage: `hermes status exited ${exitCode}` };
    }
    const modelMatch = stdout.match(/Model:\s*(\S+)/);
    if (!modelMatch) return { status: "malformed", models: [], errorMessage: "no Model: line found" };
    const model = modelMatch[1]!.trim();
    return { status: "ok", models: [{ model, provider: "hermes" }] };
  } catch (err) {
    return { status: "error", models: [], errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

// `opencode models` prints one "<provider>/<model>" id per line (its own
// zero-auth free tier shows as "opencode/<name>"; a configured external
// provider would show as "<provider>/<model>" the same way) — confirmed by
// direct invocation 2026-10-03.
export async function discoverOpenCodeModels(signal: AbortSignal, command = "opencode"): Promise<RuntimeDiscoveryResult> {
  try {
    const { stdout, exitCode } = await runCommandAndCapture(command, ["models"], signal);
    if (exitCode !== 0) {
      return { status: "error", models: [], errorMessage: `opencode models exited ${exitCode}` };
    }
    const models = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("/"))
      .map((line) => {
        const slashIndex = line.indexOf("/");
        return { model: line.slice(slashIndex + 1), provider: line.slice(0, slashIndex) };
      })
      .filter((m) => m.model.length > 0 && m.provider.length > 0);
    if (models.length === 0) return { status: "empty", models: [] };
    return { status: "ok", models };
  } catch (err) {
    return { status: "error", models: [], errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

export const RUNTIME_DISCOVERY_SOURCES: Readonly<Record<string, RuntimeDiscoverySource>> = {
  antigravity_local: discoverAntigravityModels,
  hermes_local: discoverHermesModels,
  opencode_local: discoverOpenCodeModels,
};
