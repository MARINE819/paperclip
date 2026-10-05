import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, notFound } from "../errors.js";
import { assertInstanceAdmin } from "./authz.js";
import {
  BenchmarkCaseNotFoundError,
  computeRegressionForRun,
  createBenchmarkCase,
  getAgentEvalSummary,
  getBenchmarkCase,
  getEvalRun,
  getEvalSummary,
  listBenchmarkCases,
  listEvalRuns,
  recordEvalRun,
  type AgentEvalSummary,
  type EvalBenchmarkCaseRow,
  type EvalRunRow,
} from "../services/eval-store.js";
import type { EvalRunStatus } from "../services/eval-engine.js";
import type { ValidatorSpec } from "../services/eval-validators.js";

// F-04 Agent Eval / Simulation Lab routes. Read endpoints are the
// Antigravity-facing contract documented in
// docs/contracts/nexora-f04-eval-api.md; the two POST endpoints are
// Claude-internal (instance-admin gated, same pattern as the manual backup
// route) for recording runs/benchmarks — no UI is implied or required to
// call them.

function toBenchmarkSummary(row: EvalBenchmarkCaseRow) {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    name: row.name,
    description: row.description,
    category: row.category,
    active: row.active,
    validatorSpec: row.validatorSpec,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRunSummary(row: EvalRunRow) {
  return {
    id: row.id,
    taskId: row.taskId,
    benchmarkKey: row.benchmarkKey,
    benchmarkVersion: row.benchmarkVersion,
    agentId: row.agentId,
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    success: row.success,
    accuracy: row.accuracy != null ? Number(row.accuracy) : null,
    latencyMs: row.latencyMs,
    tokenUsage: row.tokenUsage,
    costEstimated: row.costEstimated != null ? Number(row.costEstimated) : null,
    costActual: row.costActual != null ? Number(row.costActual) : null,
    failureType: row.failureType,
    retryCount: row.retryCount,
    retryOfRunId: row.retryOfRunId,
    createdAt: row.createdAt,
  };
}

function toRunDetail(row: EvalRunRow) {
  return {
    ...toRunSummary(row),
    evidence: row.evidence,
    validatorResults: row.validatorResults,
  };
}

function toAgentSummary(summary: AgentEvalSummary) {
  return {
    agentId: summary.agentId,
    latestEval: summary.latestEval ? toRunSummary(summary.latestEval) : null,
    passRate: summary.passRate,
    avgLatencyMs: summary.avgLatencyMs,
    avgCost: summary.avgCost,
    recentRegression: summary.recentRegression,
    recentRuns: summary.recentRuns.map(toRunSummary),
  };
}

export function evalRoutes(db: Db) {
  const router = Router();

  // ─── Antigravity READ contract ──────────────────────────────────────────

  router.get("/evals/benchmarks", async (req, res) => {
    assertInstanceAdmin(req);
    const activeOnly = req.query.activeOnly !== "false";
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const rows = await listBenchmarkCases(db, { activeOnly, category });
    res.json({ benchmarks: rows.map(toBenchmarkSummary) });
  });

  router.get("/evals/runs", async (req, res) => {
    assertInstanceAdmin(req);
    const rows = await listEvalRuns(db, {
      taskId: typeof req.query.taskId === "string" ? req.query.taskId : undefined,
      benchmarkKey: typeof req.query.benchmarkKey === "string" ? req.query.benchmarkKey : undefined,
      agentId: typeof req.query.agentId === "string" ? req.query.agentId : undefined,
      modelProvider: typeof req.query.modelProvider === "string" ? req.query.modelProvider : undefined,
      modelName: typeof req.query.modelName === "string" ? req.query.modelName : undefined,
      status: typeof req.query.status === "string" ? (req.query.status as EvalRunStatus) : undefined,
      limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
    });
    res.json({ runs: rows.map(toRunSummary) });
  });

  router.get("/evals/runs/:id", async (req, res) => {
    assertInstanceAdmin(req);
    const row = await getEvalRun(db, req.params.id);
    if (!row) throw notFound("Eval run not found");
    const regression = await computeRegressionForRun(db, row.id);
    res.json({ run: toRunDetail(row), regression });
  });

  router.get("/evals/summary", async (req, res) => {
    assertInstanceAdmin(req);
    const benchmarkKey = typeof req.query.benchmarkKey === "string" ? req.query.benchmarkKey : undefined;
    const entries = await getEvalSummary(db, benchmarkKey);
    res.json({ summary: entries });
  });

  // Server-computed per-agent summary: passRate/avgLatencyMs/avgCost are
  // aggregated here so the frontend never computes metrics itself. Empty
  // state (agent has never run an eval) is a 200 with nulls/[], not a 404 —
  // this route does not own whether agentId is a real, existing agent.
  router.get("/evals/agents/:agentId/summary", async (req, res) => {
    assertInstanceAdmin(req);
    const limit = typeof req.query.recentRunsLimit === "string" ? Number(req.query.recentRunsLimit) : undefined;
    const summary = await getAgentEvalSummary(db, req.params.agentId, limit);
    res.json({ agent: toAgentSummary(summary) });
  });

  // ─── Claude-internal write API (not part of the Antigravity contract) ──

  router.post("/evals/benchmarks", async (req, res) => {
    assertInstanceAdmin(req);
    const body = req.body as Record<string, unknown>;
    if (typeof body?.key !== "string" || typeof body?.name !== "string" || !body?.taskDefinition) {
      throw badRequest("key, name, and taskDefinition are required");
    }
    const row = await createBenchmarkCase(db, {
      key: body.key,
      version: typeof body.version === "number" ? body.version : undefined,
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      category: typeof body.category === "string" ? body.category : undefined,
      taskDefinition: body.taskDefinition as Record<string, unknown>,
      validatorSpec: Array.isArray(body.validatorSpec) ? (body.validatorSpec as ValidatorSpec[]) : [],
      active: typeof body.active === "boolean" ? body.active : undefined,
    });
    res.status(201).json({ benchmark: toBenchmarkSummary(row) });
  });

  router.post("/evals/runs", async (req, res) => {
    assertInstanceAdmin(req);
    const body = req.body as Record<string, unknown>;
    if (typeof body?.taskId !== "string" || typeof body?.modelProvider !== "string" || typeof body?.modelName !== "string") {
      throw badRequest("taskId, modelProvider, and modelName are required");
    }
    if (!await getBenchmarkCase(db, body.taskId)) {
      throw notFound("Benchmark case not found");
    }
    try {
      const row = await recordEvalRun(db, {
        taskId: body.taskId,
        agentId: typeof body.agentId === "string" ? body.agentId : null,
        modelProvider: body.modelProvider,
        modelName: body.modelName,
        startedAt: typeof body.startedAt === "string" ? new Date(body.startedAt) : null,
        completedAt: typeof body.completedAt === "string" ? new Date(body.completedAt) : null,
        actualResult: body.actualResult ?? {},
        judgeResults: Array.isArray(body.judgeResults) ? body.judgeResults : undefined,
        accuracy: typeof body.accuracy === "number" ? body.accuracy : null,
        latencyMs: typeof body.latencyMs === "number" ? body.latencyMs : null,
        tokenUsage: (body.tokenUsage as { input?: number; output?: number; total?: number }) ?? null,
        costEstimated: typeof body.costEstimated === "number" ? body.costEstimated : null,
        costActual: typeof body.costActual === "number" ? body.costActual : null,
        failureType: typeof body.failureType === "string" ? body.failureType : null,
        retryCount: typeof body.retryCount === "number" ? body.retryCount : undefined,
        retryOfRunId: typeof body.retryOfRunId === "string" ? body.retryOfRunId : null,
        evidence: Array.isArray(body.evidence) ? body.evidence : undefined,
      });
      res.status(201).json({ run: toRunDetail(row) });
    } catch (error) {
      if (error instanceof BenchmarkCaseNotFoundError) throw notFound(error.message);
      throw error;
    }
  });

  return router;
}
