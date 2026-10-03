import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __setExecutorRegistryForTests,
  type ExecutorRecord,
} from "../services/executor-registry.js";

// CRITICAL CLOSURE REQUIREMENT verification: these tests prove the router's
// selectedExecutor/fallbackChain actually determine which adapter module's
// execute() function is invoked at the real heartbeat dispatch call site —
// not merely computed/logged alongside a dispatch that still silently used
// agent.adapterType. See server/src/services/heartbeat.ts's
// effectiveDispatchAdapterType / dispatchWithAdapter wiring.

const codexExecute = vi.hoisted(() => vi.fn());
const claudeExecute = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: (adapterType?: string) =>
    adapterType === "claude_local"
      ? { type: "claude_local", execute: claudeExecute, supportsLocalAgentJwt: false }
      : { type: "codex_local", execute: codexExecute, supportsLocalAgentJwt: false },
  findActiveServerAdapter: (adapterType?: string) =>
    adapterType === "claude_local"
      ? { type: "claude_local", execute: claudeExecute, supportsLocalAgentJwt: false }
      : { type: "codex_local", execute: codexExecute, supportsLocalAgentJwt: false },
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function okResult(model: string | null) {
  return {
    exitCode: 0,
    errorCode: null,
    signal: null,
    timedOut: false,
    sessionParams: { sessionId: "dispatch-test-session" },
    sessionDisplayId: "dispatch-test-session",
    provider: "test",
    model,
  };
}

function failResult(errorCode: string) {
  return {
    exitCode: 1,
    errorCode,
    signal: null,
    timedOut: false,
    sessionParams: { sessionId: "dispatch-test-session" },
    sessionDisplayId: "dispatch-test-session",
    provider: "test",
    model: null,
  };
}

// Two confirmed_working CODING_AGENT_RUNTIME executors — real registry data
// today has only one (codex_local), so this synthetic override is the only
// way to dispatch-level-exercise genuine cross-executor selection and bounded
// fallback. Zero production behavior is affected: __setExecutorRegistryForTests
// is a test-only seam (see executor-registry.ts) always reset in afterEach.
function buildTwoExecutorRegistry(): ExecutorRecord[] {
  const sharedCapabilities = {
    tools: true as const,
    fileEditing: true as const,
    terminal: true as const,
    browser: "unknown" as const,
    gui: "unknown" as const,
    localExecution: "unknown" as const,
    multiAgent: "unknown" as const,
  };
  const base = {
    category: "CODING_AGENT_RUNTIME" as const,
    enabled: true,
    operationalStatus: "confirmed_working" as const,
    capabilities: sharedCapabilities,
    supportsModels: true,
    modelSourceType: "static_registry" as const,
    isLocal: true,
    costClass: "mid" as const,
    speedClass: "standard" as const,
    maxContextTokens: null,
    healthStatus: "healthy" as const,
    lastVerifiedAt: null,
    sourceType: "builtin" as const,
    repository: null,
    installPath: null,
    version: null,
    binaryPath: null,
    launchCommandReference: null,
    healthCheckStrategy: null,
  };
  return [
    { ...base, executorId: "test-codex", executorType: "codex_local", adapterType: "codex_local", provider: "openai" },
    { ...base, executorId: "test-claude", executorType: "claude_local", adapterType: "claude_local", provider: "anthropic" },
  ];
}

async function waitForRunToFinish(
  heartbeat: { getRun: (runId: string) => Promise<{ status: string } | null> },
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("Intelligent Execution Router — real dispatch wiring (CEO closure requirement)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-execution-router-dispatch-");
    db = createDb(tempDb.connectionString);
    codexExecute.mockReset();
    claudeExecute.mockReset();
  }, 20_000);

  afterEach(async () => {
    __setExecutorRegistryForTests(null);
    await tempDb?.cleanup();
    tempDb = null;
  });

  async function seedCompanyAgentIssue(input: {
    adapterType?: string;
    // Dispatch-time effective config (e.g. an explicit model override) is
    // built from agent.adapterConfig, not agent.runtimeConfig — confirmed by
    // reading resolveExecutionRunAdapterConfig's call chain in heartbeat.ts
    // (const config = parseObject(agent.adapterConfig)).
    adapterConfig?: Record<string, unknown>;
    // Pin semantics (executorPinned/adapterPinned/providerPinned) are a
    // routing-behavior toggle read from the agent's own AgentRuntimeConfig
    // column directly (see resolveDynamicExecutionRoute's agentRuntimeConfig
    // param), same column modelProfiles already lives on.
    runtimeConfig?: Record<string, unknown>;
    modelTier?: "T1" | "T2" | "T3" | "T4";
    // Issue-level adapterConfig override (merged on top of the agent's own
    // adapterConfig at dispatch time) — the run-scoped way to inject an
    // explicit model override without touching agent.adapterConfig at
    // insert time (which triggers an unrelated earlier gate unsuited to this
    // test's minimal fixture).
    issueAdapterConfig?: Record<string, unknown>;
    title?: string;
    description?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Execution Router Dispatch Co",
      issuePrefix: `ER${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Dispatch Agent",
      role: "engineer",
      status: "idle",
      adapterType: input.adapterType ?? "codex_local",
      adapterConfig: input.adapterConfig ?? {},
      runtimeConfig: input.runtimeConfig ?? {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `ER-${issueId.slice(0, 8)}`,
      title: input.title ?? "Summarize recent activity",
      description: input.description ?? "Read-only summary task.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      assigneeAdapterOverrides:
        input.modelTier || input.issueAdapterConfig
          ? {
              ...(input.modelTier ? { modelTier: input.modelTier } : {}),
              ...(input.issueAdapterConfig ? { adapterConfig: input.issueAdapterConfig } : {}),
            }
          : null,
    });
    return { companyId, agentId, issueId };
  }

  it("A. router selects a DIFFERENT executor than agent.adapterType -> the OTHER executor's execute function is actually called", async () => {
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    claudeExecute.mockResolvedValue(okResult("claude-sonnet-5"));
    const { agentId, issueId } = await seedCompanyAgentIssue({
      adapterType: "codex_local",
      issueAdapterConfig: { model: "claude-sonnet-5" }, // explicit override resolves to claude_local
    });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    await waitForRunToFinish(heartbeat, queued!.id);

    expect(claudeExecute).toHaveBeenCalledTimes(1);
    expect(codexExecute).not.toHaveBeenCalled();
    // Full (executor, provider, model) tuple reaches the actual dispatch
    // config, not just the model — the original agent/executor's provider
    // (openai) must not leak into the redirected claude_local/anthropic call.
    const callArgs = claudeExecute.mock.calls[0]![0] as { config: { model?: string; provider?: string } };
    expect(callArgs.config.model).toBe("claude-sonnet-5");
    expect(callArgs.config.provider).toBe("anthropic");
    expect(callArgs.config.provider).not.toBe("openai");
  }, 15_000);

  it("B. router selects the SAME executor as agent.adapterType -> existing path is unchanged", async () => {
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    codexExecute.mockResolvedValue(okResult(DEFAULT_CODEX_LOCAL_MODEL));
    const { agentId, issueId } = await seedCompanyAgentIssue({ adapterType: "codex_local" });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    await waitForRunToFinish(heartbeat, queued!.id);

    expect(codexExecute).toHaveBeenCalledTimes(1);
    expect(claudeExecute).not.toHaveBeenCalled();

    // Neural telemetry (Phase 2B MVP): no fallback occurred, so
    // routedExecutor and actualExecutor must agree, and the actual observed
    // provider/model come straight from the adapter's own result.
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.resultJson?.routedExecutor).toBe("codex_local");
    expect(finished?.resultJson?.actualExecutor).toBe("codex_local");
    expect(finished?.resultJson?.executorWasRedirected).toBe(false);
    expect(finished?.resultJson?.provider).toBe("test");
    expect(finished?.resultJson?.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
  }, 15_000);

  it("C. retryable primary failure -> actual re-dispatch to the next fallback candidate's execute function", async () => {
    __setExecutorRegistryForTests(buildTwoExecutorRegistry());
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    codexExecute.mockResolvedValue(failResult("rate_limited"));
    claudeExecute.mockResolvedValue(okResult("claude-sonnet-5"));
    const { agentId, issueId } = await seedCompanyAgentIssue({ adapterType: "codex_local", modelTier: "T2" });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    await waitForRunToFinish(heartbeat, queued!.id);

    expect(codexExecute).toHaveBeenCalledTimes(1);
    expect(claudeExecute).toHaveBeenCalledTimes(1);
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    // Full tuple per attempt, and no stale provider leakage from the primary
    // attempt into the fallback attempt's dispatched config.
    const primaryCallArgs = codexExecute.mock.calls[0]![0] as { config: { model?: string; provider?: string } };
    const fallbackCallArgs = claudeExecute.mock.calls[0]![0] as { config: { model?: string; provider?: string } };
    expect(primaryCallArgs.config.provider).toBe("openai");
    expect(fallbackCallArgs.config.provider).toBe("anthropic");
    expect(fallbackCallArgs.config.provider).not.toBe("openai");
    expect(fallbackCallArgs.config.model).toBe("claude-sonnet-5");

    // Neural telemetry (Phase 2B MVP): this is the exact scenario the CEO's
    // FINAL EXECUTOR SEMANTICS CHECK was raised over — routedExecutor (the
    // primary route decision) must stay "codex_local" while actualExecutor
    // (whichever attempt actually produced the terminal adapterResult) must
    // reflect the fallback that really ran, "claude_local". provider/model
    // are the actual values observed from that same fallback adapterResult.
    expect(finished?.resultJson?.routedExecutor).toBe("codex_local");
    expect(finished?.resultJson?.actualExecutor).toBe("claude_local");
    expect(finished?.resultJson?.provider).toBe("test");
    expect(finished?.resultJson?.model).toBe("claude-sonnet-5");
  }, 15_000);

  it("D. non-retryable primary failure -> zero fallback dispatch", async () => {
    __setExecutorRegistryForTests(buildTwoExecutorRegistry());
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    codexExecute.mockResolvedValue(failResult("authentication_failure"));
    claudeExecute.mockResolvedValue(okResult("claude-sonnet-5"));
    const { agentId, issueId } = await seedCompanyAgentIssue({ adapterType: "codex_local", modelTier: "T2" });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    await waitForRunToFinish(heartbeat, queued!.id);

    expect(codexExecute).toHaveBeenCalledTimes(1);
    expect(claudeExecute).not.toHaveBeenCalled();
  }, 15_000);

  it("E. explicit pin (adapterPinned) -> router cannot change executor outside pin semantics, even with a competing confirmed_working peer and a retryable failure", async () => {
    __setExecutorRegistryForTests(buildTwoExecutorRegistry());
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    codexExecute.mockResolvedValue(failResult("rate_limited"));
    claudeExecute.mockResolvedValue(okResult("claude-sonnet-5"));
    const { agentId, issueId } = await seedCompanyAgentIssue({
      adapterType: "codex_local",
      runtimeConfig: { adapterPinned: true },
      modelTier: "T2",
    });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    await waitForRunToFinish(heartbeat, queued!.id);

    // Pinned path never populates a fallbackChain, so even a retryable
    // failure on the primary (and only) candidate cannot dispatch elsewhere.
    expect(codexExecute).toHaveBeenCalledTimes(1);
    expect(claudeExecute).not.toHaveBeenCalled();
  }, 15_000);

  it("E2. providerPinned alone (not adapterPinned/executorPinned) is independently sufficient to pin routing, even with a competing confirmed_working peer and a retryable failure", async () => {
    __setExecutorRegistryForTests(buildTwoExecutorRegistry());
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    codexExecute.mockResolvedValue(failResult("rate_limited"));
    claudeExecute.mockResolvedValue(okResult("claude-sonnet-5"));
    const { agentId, issueId } = await seedCompanyAgentIssue({
      adapterType: "codex_local",
      runtimeConfig: { providerPinned: true },
      modelTier: "T2",
    });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    await waitForRunToFinish(heartbeat, queued!.id);

    expect(codexExecute).toHaveBeenCalledTimes(1);
    expect(claudeExecute).not.toHaveBeenCalled();
    const callArgs = codexExecute.mock.calls[0]![0] as { config: { provider?: string } };
    expect(callArgs.config.provider).toBe("openai");
  }, 15_000);

  it("F. stale gpt-5 default is gone from the active dispatch path: a T2 tier request dispatches with the adapter package's current default, never the literal \"gpt-5\"", async () => {
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    codexExecute.mockResolvedValue(okResult(DEFAULT_CODEX_LOCAL_MODEL));
    const { agentId, issueId } = await seedCompanyAgentIssue({ adapterType: "codex_local", modelTier: "T2" });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    await waitForRunToFinish(heartbeat, queued!.id);

    expect(codexExecute).toHaveBeenCalledTimes(1);
    const callArgs = codexExecute.mock.calls[0]![0] as { config: { model?: string } };
    expect(callArgs.config.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(callArgs.config.model).not.toBe("gpt-5");
  }, 15_000);
});
