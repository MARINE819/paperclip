import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

// JARVIS Neural Command Interface (Phase 2B MVP): GET
// /companies/:companyId/neural-routes returns one truthful routing telemetry
// row per agent (active run first, otherwise that agent's latest terminal
// run) — same "active first, otherwise latest terminal" convention
// /live-runs already uses, never depending on accidental DB row ordering.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres neural-routes route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

function createApp(db: Db, companyIds: string[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds,
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function seedCompany(db: Db, label: string) {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `${label} Co`,
    issuePrefix: `NR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    status: "active",
    requireBoardApprovalForNewAgents: false,
    defaultResponsibleUserId: "responsible-user",
  });
  return companyId;
}

async function seedAgent(db: Db, companyId: string, name: string) {
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name,
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  return agentId;
}

async function seedRun(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    status: string;
    createdAt: Date;
    resultJson?: Record<string, unknown> | null;
    errorCode?: string | null;
  },
) {
  const [row] = await db
    .insert(heartbeatRuns)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      status: input.status,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      errorCode: input.errorCode ?? null,
      resultJson: input.resultJson ?? null,
    })
    .returning({ id: heartbeatRuns.id });
  return row!.id;
}

describeEmbeddedPostgres("GET /companies/:companyId/neural-routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("neural-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("selects the active run over an older terminal run for the same agent", async () => {
    const companyId = await seedCompany(db, "Active");
    const agentId = await seedAgent(db, companyId, "Agent Active");
    const olderTerminalId = await seedRun(db, {
      companyId,
      agentId,
      status: "succeeded",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      resultJson: { routedExecutor: "codex_local", actualExecutor: "codex_local" },
    });
    const activeId = await seedRun(db, {
      companyId,
      agentId,
      status: "running",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      resultJson: null,
    });

    const res = await request(createApp(db, [companyId])).get(`/api/companies/${companyId}/neural-routes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].runId).toBe(activeId);
    expect(res.body[0].runId).not.toBe(olderTerminalId);
    expect(res.body[0].status).toBe("running");
    expect(res.body[0].source).toBe("live");
    // Active run with no terminal adapterResult yet — never fabricated.
    expect(res.body[0].actualExecutor).toBeNull();
    expect(res.body[0].provider).toBeNull();
    expect(res.body[0].model).toBeNull();
  });

  it("falls back to the latest terminal run when no active run exists", async () => {
    const companyId = await seedCompany(db, "Terminal");
    const agentId = await seedAgent(db, companyId, "Agent Terminal");
    await seedRun(db, {
      companyId,
      agentId,
      status: "failed",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      resultJson: { routedExecutor: "codex_local", actualExecutor: "codex_local" },
    });
    const latestId = await seedRun(db, {
      companyId,
      agentId,
      status: "succeeded",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      resultJson: {
        routedExecutor: "codex_local",
        actualExecutor: "claude_local",
        executorWasRedirected: false,
        routingReason: "tier_routing",
        fixedRoutingReason: null,
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    });

    const res = await request(createApp(db, [companyId])).get(`/api/companies/${companyId}/neural-routes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      runId: latestId,
      agentId,
      status: "succeeded",
      source: "live",
      routedExecutor: "codex_local",
      actualExecutor: "claude_local",
      routingReason: "tier_routing",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
  });

  it("returns at most one row per agent and nothing for an agent with zero runs", async () => {
    const companyId = await seedCompany(db, "Multi");
    const agentWithRuns = await seedAgent(db, companyId, "Agent With Runs");
    await seedAgent(db, companyId, "Agent No Runs");
    await seedRun(db, {
      companyId,
      agentId: agentWithRuns,
      status: "succeeded",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await seedRun(db, {
      companyId,
      agentId: agentWithRuns,
      status: "succeeded",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const res = await request(createApp(db, [companyId])).get(`/api/companies/${companyId}/neural-routes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].agentId).toBe(agentWithRuns);
  });

  it("never leaks another company's runs, and never leaks raw stdout/stderr/error", async () => {
    const companyA = await seedCompany(db, "A");
    const companyB = await seedCompany(db, "B");
    const agentA = await seedAgent(db, companyA, "Agent A");
    const agentB = await seedAgent(db, companyB, "Agent B");
    await seedRun(db, {
      companyId: companyA,
      agentId: agentA,
      status: "failed",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      errorCode: "windows_control_c_exit_detected",
      resultJson: {
        routedExecutor: "codex_local",
        actualExecutor: "codex_local",
        stdout: "SECRET_STDOUT_SHOULD_NOT_LEAK",
        stderr: "SECRET_STDERR_SHOULD_NOT_LEAK",
        error: "SECRET_ERROR_SHOULD_NOT_LEAK",
      },
    });
    await seedRun(db, {
      companyId: companyB,
      agentId: agentB,
      status: "succeeded",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const res = await request(createApp(db, [companyA])).get(`/api/companies/${companyA}/neural-routes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].agentId).toBe(agentA);
    expect(res.body[0].errorCode).toBe("windows_control_c_exit_detected");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("SECRET_STDOUT_SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("SECRET_STDERR_SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("SECRET_ERROR_SHOULD_NOT_LEAK");
  });

  it("is deterministic across repeated requests regardless of DB row insertion order", async () => {
    const companyId = await seedCompany(db, "Deterministic");
    const agentId = await seedAgent(db, companyId, "Agent Deterministic");
    const sameTimestamp = new Date("2026-01-01T00:00:00.000Z");
    const first = await seedRun(db, { companyId, agentId, status: "succeeded", createdAt: sameTimestamp });
    const second = await seedRun(db, { companyId, agentId, status: "succeeded", createdAt: sameTimestamp });

    const app = createApp(db, [companyId]);
    const resOne = await request(app).get(`/api/companies/${companyId}/neural-routes`);
    const resTwo = await request(app).get(`/api/companies/${companyId}/neural-routes`);

    expect(resOne.body).toHaveLength(1);
    expect(resTwo.body).toHaveLength(1);
    expect(resOne.body[0].runId).toBe(resTwo.body[0].runId);
    expect([first, second]).toContain(resOne.body[0].runId);
  });
});
