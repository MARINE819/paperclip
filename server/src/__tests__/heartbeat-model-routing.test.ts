import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.ts";

const executeNativeCodexRunner = vi.hoisted(() => vi.fn(async (args: { model?: string | null }) => ({
  exitCode: 0,
  errorCode: null,
  errorMessage: null,
  summary: "ok",
  provider: "codex",
  model: args.model ?? null,
  resultJson: {},
})));

vi.mock("../services/native-runtime/native-codex-runner.js", () => ({
  executeNativeCodexRunner,
}));

vi.mock("../services/native-runtime/prepare-native-run.js", () => ({
  prepareNativeHeartbeatRun: vi.fn(async () => ({
    runnerInstanceId: "runner-1",
    environmentLeaseId: "lease-1",
    normalizedSessionId: "session-1",
    turnId: "turn-1",
    itemId: "item-1",
    completionContract: null,
  })),
}));

vi.mock("../services/native-runtime/runtime-mode.js", () => ({
  NATIVE_RUNTIME_RESOLVER_VERSION: "paperclip-runner-v1",
  resolveHeartbeatRuntimeMode: () => ({
    kind: "native",
    resolverVersion: "paperclip-runner-v1",
    reason: "explicit_paperclip_runner",
    provider: "codex",
  }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

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

describeEmbeddedPostgres("Heartbeat Stage 7 model routing — native runner direct execution evidence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-model-routing-");
    db = createDb(tempDb.connectionString);
    executeNativeCodexRunner.mockClear();
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
  }, 20_000);

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  });

  async function seedCompanyAgentIssue(input: {
    modelTier?: "T1" | "T2" | "T3" | "T4";
    runtimeConfigModel?: string;
    provider?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const provider = input.provider ?? "codex";

    await db.insert(companies).values({
      id: companyId,
      name: "Model Routing Co",
      issuePrefix: `MR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native Runner Agent",
      role: "engineer",
      status: "active",
      adapterType: "paperclip_runner",
      // NOTE: heartbeat.ts's dispatch-time "runtimeConfig" local variable
      // (the one resolveEffectiveModelSelection reads .model from) is built
      // from agent.adapterConfig (see `const config = parseObject(agent.adapterConfig)`
      // at heartbeat.ts:14433), not the agents.runtimeConfig DB column. That
      // column is used for unrelated heartbeat/maxTurnContinuation policy.
      adapterConfig: input.runtimeConfigModel
        ? { provider, model: input.runtimeConfigModel }
        : { provider },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `MR-${issueId.slice(0, 8)}`,
      title: "Read-only summary task",
      description: "Summarize recent activity.",
      status: "todo",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      assigneeAdapterOverrides: input.modelTier ? { modelTier: input.modelTier } : null,
    });
    return { companyId, agentId, issueId };
  }

  async function getFinishedRun(agentId: string) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(heartbeatRuns.createdAt)
      .limit(1);
    return run;
  }

  it("passes the agent's explicit runtimeConfig.model into executeNativeCodexRunner unchanged (legacy-compatible path)", async () => {
    // NOTE (Stage 7 Phase 7.6): the Model Registry itself still has zero
    // entries for adapterType="paperclip_runner" directly. Since Phase 7.6,
    // paperclip_runner + adapterConfig.provider="codex" is allowed to look up
    // codex_local's registry rows via a lookup-only alias (see
    // resolveEffectiveModelSelection in heartbeat.ts) — covered by the
    // dedicated alias test below. This test still isolates the pre-existing
    // explicit-override path, which always wins regardless of alias.
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    const { agentId, issueId } = await seedCompanyAgentIssue({
      modelTier: "T2",
      runtimeConfigModel: "gpt-5-explicit",
    });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: "Summarize recent activity." },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    expect(queued).not.toBeNull();
    await waitForRunToFinish(heartbeat, queued!.id);

    expect(executeNativeCodexRunner).toHaveBeenCalledTimes(1);
    const callArgs = executeNativeCodexRunner.mock.calls[0]![0] as { model: string | null };
    expect(callArgs.model).toBe("gpt-5-explicit");
  });

  it("skips executeNativeCodexRunner and fails closed with model_not_found when no route is available (non-codex provider, no alias)", async () => {
    // provider is deliberately non-codex here: since Phase 7.6, a "codex"
    // provider would alias to codex_local's registry (which has coverage).
    // A non-codex provider gets no alias and no direct registry entries of
    // its own, so this remains a genuine no_route_available case.
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    const { agentId, issueId } = await seedCompanyAgentIssue({ provider: "gemini" });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: "Summarize recent activity." },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    expect(queued).not.toBeNull();
    await waitForRunToFinish(heartbeat, queued!.id);

    const run = await getFinishedRun(agentId);
    expect(executeNativeCodexRunner).not.toHaveBeenCalled();
    expect(run?.errorCode).toBe("model_not_found");
  });

  it("aliases paperclip_runner + provider=codex to codex_local's registry for tier routing, while execution adapter identity stays paperclip_runner", async () => {
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    const { agentId, issueId } = await seedCompanyAgentIssue({
      modelTier: "T2",
      provider: "codex",
    });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: "Summarize recent activity." },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    expect(queued).not.toBeNull();
    await waitForRunToFinish(heartbeat, queued!.id);

    expect(executeNativeCodexRunner).toHaveBeenCalledTimes(1);
    const callArgs = executeNativeCodexRunner.mock.calls[0]![0] as { model: string | null };
    // codex_local's T2 registry model, reached only via the lookup alias.
    expect(callArgs.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);

    const run = await getFinishedRun(agentId);
    expect(run?.errorCode).toBeNull();
    const resultJson = run?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.routingTier).toBe("T2");
    expect(resultJson?.routingReason).toBe("tier_routing");
  });
});
