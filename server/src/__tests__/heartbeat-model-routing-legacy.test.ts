import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Reuses the exact mock pattern from heartbeat-risk-guard.test.ts, capturing
// the config object each adapter.execute call receives so the routed model
// (or its absence) can be asserted directly against the real legacy
// dispatch path in heartbeat.ts, not just the pure model-router unit tests.
const adapterExecute = vi.hoisted(() => vi.fn(async (args: { config: { model?: string } }) => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "legacy-routing-session" },
  sessionDisplayId: "legacy-routing-session",
  provider: "test",
  model: args.config.model ?? null,
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: (adapterType?: string) => ({
    type: adapterType || "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: (adapterType?: string) => ({
    type: adapterType || "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
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

describeEmbeddedPostgres("Heartbeat Stage 7 Phase 7.6 model routing — real legacy adapter.execute() path", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-model-routing-legacy-");
    db = createDb(tempDb.connectionString);
    adapterExecute.mockClear();
  }, 20_000);

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  });

  async function seedCompanyAgentIssue(input: {
    adapterType: "codex_local" | "claude_local" | "gemini_local";
    modelTier?: "T1" | "T2" | "T3" | "T4";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Legacy Model Routing Co",
      issuePrefix: `LR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy Routing Agent",
      role: "engineer",
      status: "idle",
      adapterType: input.adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `LR-${issueId.slice(0, 8)}`,
      title: "Summarize recent activity",
      description: "Read-only summary task.",
      status: "todo",
      priority: "medium",
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

  it("routes codex_local + T1 to the codex_local T1 registry model via the real adapter.execute() call", async () => {
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    const { agentId, issueId } = await seedCompanyAgentIssue({
      adapterType: "codex_local",
      modelTier: "T1",
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

    expect(adapterExecute).toHaveBeenCalledTimes(1);
    const callArgs = adapterExecute.mock.calls[0]![0] as { config: { model?: string } };
    expect(callArgs.config.model).toBe("gpt-5-mini");

    const run = await getFinishedRun(agentId);
    const resultJson = run?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.routingTier).toBe("T1");
    expect(resultJson?.routingReason).toBe("tier_routing");
  }, 15_000);

  it("routes claude_local + T2 to the claude_local T2 registry model via the real adapter.execute() call", async () => {
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    const { agentId, issueId } = await seedCompanyAgentIssue({
      adapterType: "claude_local",
      modelTier: "T2",
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

    expect(adapterExecute).toHaveBeenCalledTimes(1);
    const callArgs = adapterExecute.mock.calls[0]![0] as { config: { model?: string } };
    expect(callArgs.config.model).toBe("claude-sonnet-5");

    const run = await getFinishedRun(agentId);
    const resultJson = run?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.routingTier).toBe("T2");
    expect(resultJson?.routingReason).toBe("tier_routing");
  }, 15_000);

  it("2026-10-03 revision: gemini_local is still unverified, so an unpinned agent configured on it no longer gets a free incumbency pass — it is redirected to a real confirmed_working peer honoring the requested T3 tier, never silently kept on gemini_local's own stale default", async () => {
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    const { agentId, issueId } = await seedCompanyAgentIssue({
      adapterType: "gemini_local",
      modelTier: "T3",
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

    expect(adapterExecute).toHaveBeenCalledTimes(1);
    const callArgs = adapterExecute.mock.calls[0]![0] as { config: { model?: string } };
    // Redirected to a real T3-tier CODING_AGENT_RUNTIME peer (codex_local's
    // gpt-5.4 or claude_local's claude-opus-5 — which one wins is an
    // internal tie-break detail among equally-qualified peers, not asserted
    // here) — never gemini_local's own stale T1 default, and never left
    // unrouted.
    expect(["gpt-5.4", "claude-opus-5"]).toContain(callArgs.config.model);
    expect(callArgs.config.model).not.toBe("gemini-2.0-flash-lite");

    const run = await getFinishedRun(agentId);
    const resultJson = run?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.routingTier).toBe("T3");
    expect(resultJson?.routingReason).toBe("tier_routing");
  }, 15_000);

  it("never calls adapter.execute and fails closed with model_not_found for an adapterType absent from the registry", async () => {
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db);
    const { agentId, issueId } = await seedCompanyAgentIssue({
      // "grok" is not a real adapter package, but heartbeat.ts's legacy
      // dispatch only cares about agent.adapterType as a routing key here —
      // the mocked ../adapters/index.js above returns a generic execute stub
      // for any adapterType, isolating the routing fail-closed behavior from
      // real adapter-registry validation (out of scope for this test).
      adapterType: "grok" as unknown as "codex_local",
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

    expect(adapterExecute).not.toHaveBeenCalled();
    const run = await getFinishedRun(agentId);
    expect(run?.errorCode).toBe("model_not_found");
  }, 15_000);
});
