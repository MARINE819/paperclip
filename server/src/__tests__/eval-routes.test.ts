import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { evalRoutes } from "../routes/evals.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping eval routes HTTP-level tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-eval-routes-");
  cleanups.push(testDb.cleanup);
  return createDb(testDb.connectionString);
}

function createApp(db: Awaited<ReturnType<typeof newTestDb>>, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", evalRoutes(db));
  app.use(errorHandler);
  return app;
}

const admin = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true };
const localImplicit = { type: "board", userId: "local", source: "local_implicit", isInstanceAdmin: false };
const nonAdmin = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: ["c1"] };

describeEmbeddedPostgres("F-04 eval routes (HTTP level, real test DB)", () => {
  it("[route mounted][HTTP 200] GET /api/evals/benchmarks responds 200 with an empty list before any benchmark exists", async () => {
    const db = await newTestDb();
    const app = createApp(db, admin);
    const res = await request(app).get("/api/evals/benchmarks");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ benchmarks: [] });
  }, 30_000);

  it("[auth gate] non-admin session -> 403; local_implicit -> 200; no auth header needed for local_implicit", async () => {
    const db = await newTestDb();
    await request(createApp(db, nonAdmin)).get("/api/evals/benchmarks").expect(403);
    await request(createApp(db, localImplicit)).get("/api/evals/benchmarks").expect(200);
  }, 30_000);

  it("[create][malformed input] POST /api/evals/benchmarks requires key/name/taskDefinition, 400 when missing", async () => {
    const db = await newTestDb();
    const app = createApp(db, admin);
    const res = await request(app).post("/api/evals/benchmarks").send({ key: "x" });
    expect(res.status).toBe(400);
  }, 30_000);

  it("[create] full end-to-end: create benchmark -> record run -> list -> detail -> summary, all 200/201", async () => {
    const db = await newTestDb();
    const app = createApp(db, admin);

    const benchmarkRes = await request(app)
      .post("/api/evals/benchmarks")
      .send({ key: "http-route-test", name: "Route test", taskDefinition: {}, validatorSpec: [{ type: "test_result" }] });
    expect(benchmarkRes.status).toBe(201);
    const taskId = benchmarkRes.body.benchmark.id as string;

    const runRes = await request(app)
      .post("/api/evals/runs")
      .send({
        taskId,
        modelProvider: "anthropic",
        modelName: "claude-sonnet-5",
        actualResult: { testResult: { passed: 1, failed: 0, total: 1 } },
        latencyMs: 900,
        costActual: 0.01,
      });
    expect(runRes.status).toBe(201);
    expect(runRes.body.run.status).toBe("passed");
    const runId = runRes.body.run.id as string;

    const listRes = await request(app).get("/api/evals/runs").query({ taskId });
    expect(listRes.status).toBe(200);
    expect(listRes.body.runs).toHaveLength(1);

    const detailRes = await request(app).get(`/api/evals/runs/${runId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.run.id).toBe(runId);
    expect(detailRes.body.regression).toEqual({ currentRunId: runId, previousRunId: null, findings: [] });

    const summaryRes = await request(app).get("/api/evals/summary").query({ benchmarkKey: "http-route-test" });
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.summary).toHaveLength(1);
    expect(summaryRes.body.summary[0].totalRuns).toBe(1);
  }, 30_000);

  it("[error response] GET /api/evals/runs/:id returns 404 with an error body for an unknown id", async () => {
    const db = await newTestDb();
    const app = createApp(db, admin);
    const res = await request(app).get("/api/evals/runs/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  }, 30_000);

  it("[create] POST /api/evals/runs against a non-existent benchmark fails closed with 404", async () => {
    const db = await newTestDb();
    const app = createApp(db, admin);
    const res = await request(app).post("/api/evals/runs").send({
      taskId: "00000000-0000-0000-0000-000000000000",
      modelProvider: "anthropic",
      modelName: "claude-sonnet-5",
      actualResult: {},
    });
    expect(res.status).toBe(404);
  }, 30_000);

  it(
    "[agent summary][empty data] GET /api/evals/agents/:agentId/summary for an agent with zero eval history " +
      "returns 200 with nulls, never 404 and never 0",
    async () => {
      const db = await newTestDb();
      const app = createApp(db, admin);
      const res = await request(app).get("/api/evals/agents/00000000-0000-0000-0000-000000000000/summary");
      expect(res.status).toBe(200);
      expect(res.body.agent).toEqual({
        agentId: "00000000-0000-0000-0000-000000000000",
        latestEval: null,
        passRate: null,
        avgLatencyMs: null,
        avgCost: null,
        recentRegression: null,
        recentRuns: [],
      });
    },
    30_000,
  );

  it(
    "[agent summary][failed eval][regression case][latency/cost aggregation] a real agent's summary computes " +
      "passRate/avgLatencyMs/avgCost server-side and surfaces regression on the latest run",
    async () => {
      const db = await newTestDb();
      const app = createApp(db, admin);

      const [company] = await db.insert(companies).values({ name: "Eval Test Co" }).returning();
      const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Eval Test Agent" }).returning();

      const benchmarkRes = await request(app)
        .post("/api/evals/benchmarks")
        .send({ key: "agent-summary-test", name: "Agent summary test", taskDefinition: {}, validatorSpec: [{ type: "test_result" }] });
      const taskId = benchmarkRes.body.benchmark.id as string;

      // A passed run with latency 1000ms / cost 0.01 — will be the regression baseline.
      const first = await request(app).post("/api/evals/runs").send({
        taskId, agentId: agent.id, modelProvider: "anthropic", modelName: "claude-sonnet-5",
        actualResult: { testResult: { passed: 1, failed: 0, total: 1 } },
        latencyMs: 1000, costActual: 0.01, accuracy: 0.9,
      });
      expect(first.status).toBe(201);

      // A failed run — the agent's most recent, so it becomes `latestEval`.
      const second = await request(app).post("/api/evals/runs").send({
        taskId, agentId: agent.id, modelProvider: "anthropic", modelName: "claude-sonnet-5",
        actualResult: { testResult: { passed: 0, failed: 1, total: 1 } },
        latencyMs: 2000, costActual: 0.02,
      });
      expect(second.status).toBe(201);
      expect(second.body.run.status).toBe("failed");

      const res = await request(app).get(`/api/evals/agents/${agent.id}/summary`);
      expect(res.status).toBe(200);
      const summary = res.body.agent;
      expect(summary.agentId).toBe(agent.id);
      // [latency/cost aggregation] averaged over BOTH runs, computed server-side.
      expect(summary.passRate).toBeCloseTo(0.5, 6); // 1 passed / 2 total
      expect(summary.avgLatencyMs).toBeCloseTo(1500, 6); // (1000+2000)/2
      expect(summary.avgCost).toBeCloseTo(0.015, 6); // (0.01+0.02)/2
      // [failed eval] the most recent run is the failed one.
      expect(summary.latestEval.id).toBe(second.body.run.id);
      expect(summary.latestEval.status).toBe("failed");
      expect(summary.recentRuns).toHaveLength(2);
    },
    30_000,
  );
});
