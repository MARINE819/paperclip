import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
import { evalBenchmarkCases, evalRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { runAllValidators, type ValidatorResult, type ValidatorSpec } from "./eval-validators.js";
import {
  computeEvalRunStatus,
  detectRunRegression,
  type EvalMetricsSnapshot,
  type EvalRunStatus,
  type RegressionFinding,
  type RegressionThresholds,
} from "./eval-engine.js";

export type EvalBenchmarkCaseRow = typeof evalBenchmarkCases.$inferSelect;
export type EvalRunRow = typeof evalRuns.$inferSelect;

export type CreateBenchmarkCaseInput = {
  key: string;
  version?: number;
  name: string;
  description?: string | null;
  category?: string;
  taskDefinition: Record<string, unknown>;
  validatorSpec: ValidatorSpec[];
  active?: boolean;
};

export async function createBenchmarkCase(db: Db, input: CreateBenchmarkCaseInput): Promise<EvalBenchmarkCaseRow> {
  const [row] = await db
    .insert(evalBenchmarkCases)
    .values({
      key: input.key,
      version: input.version ?? 1,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? "general",
      taskDefinition: input.taskDefinition,
      validatorSpec: input.validatorSpec,
      active: input.active ?? true,
    })
    .returning();
  return row;
}

export async function getBenchmarkCase(db: Db, id: string): Promise<EvalBenchmarkCaseRow | undefined> {
  const rows = await db.select().from(evalBenchmarkCases).where(eq(evalBenchmarkCases.id, id)).limit(1);
  return rows[0];
}

export async function listBenchmarkCases(
  db: Db,
  filters: { activeOnly?: boolean; category?: string } = {},
): Promise<EvalBenchmarkCaseRow[]> {
  const conditions = [];
  if (filters.activeOnly) conditions.push(eq(evalBenchmarkCases.active, true));
  if (filters.category) conditions.push(eq(evalBenchmarkCases.category, filters.category));
  const query = db.select().from(evalBenchmarkCases);
  return conditions.length > 0
    ? query.where(and(...conditions)).orderBy(desc(evalBenchmarkCases.createdAt))
    : query.orderBy(desc(evalBenchmarkCases.createdAt));
}

export type RecordEvalRunInput = {
  taskId: string;
  agentId?: string | null;
  modelProvider: string;
  modelName: string;
  startedAt?: Date | null;
  completedAt?: Date | null;
  actualResult: unknown;
  judgeResults?: ValidatorResult[];
  accuracy?: number | null;
  latencyMs?: number | null;
  tokenUsage?: { input?: number; output?: number; total?: number } | null;
  costEstimated?: number | null;
  costActual?: number | null;
  failureType?: string | null;
  retryCount?: number;
  retryOfRunId?: string | null;
  evidence?: Record<string, unknown>[];
};

export class BenchmarkCaseNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Benchmark case ${taskId} not found`);
    this.name = "BenchmarkCaseNotFoundError";
  }
}

/**
 * Records one completed (or failed) run of a benchmark case: runs every
 * deterministic validator from the benchmark's spec against
 * `actualResult`, appends any pre-computed judge result (never sufficient
 * alone — see computeEvalRunStatus), computes status, and persists.
 */
export async function recordEvalRun(db: Db, input: RecordEvalRunInput): Promise<EvalRunRow> {
  const benchmark = await getBenchmarkCase(db, input.taskId);
  if (!benchmark) throw new BenchmarkCaseNotFoundError(input.taskId);

  const deterministicResults = runAllValidators(
    benchmark.validatorSpec as ValidatorSpec[],
    input.actualResult,
  );
  const validatorResults = [...deterministicResults, ...(input.judgeResults ?? [])];
  const status = computeEvalRunStatus(validatorResults);
  const success = status === "passed" ? "true" : status === "failed" ? "false" : null;

  const [row] = await db
    .insert(evalRuns)
    .values({
      taskId: input.taskId,
      benchmarkKey: benchmark.key,
      benchmarkVersion: benchmark.version,
      agentId: input.agentId ?? null,
      modelProvider: input.modelProvider,
      modelName: input.modelName,
      status,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      success,
      accuracy: input.accuracy != null ? String(input.accuracy) : null,
      latencyMs: input.latencyMs ?? null,
      tokenUsage: input.tokenUsage ?? null,
      costEstimated: input.costEstimated != null ? String(input.costEstimated) : null,
      costActual: input.costActual != null ? String(input.costActual) : null,
      failureType: input.failureType ?? null,
      retryCount: input.retryCount ?? 0,
      retryOfRunId: input.retryOfRunId ?? null,
      evidence: input.evidence ?? [],
      validatorResults,
    })
    .returning();
  return row;
}

export async function getEvalRun(db: Db, id: string): Promise<EvalRunRow | undefined> {
  const rows = await db.select().from(evalRuns).where(eq(evalRuns.id, id)).limit(1);
  return rows[0];
}

export type ListEvalRunsFilters = {
  taskId?: string;
  benchmarkKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelName?: string;
  status?: EvalRunStatus;
  limit?: number;
};

export async function listEvalRuns(db: Db, filters: ListEvalRunsFilters = {}): Promise<EvalRunRow[]> {
  const conditions = [];
  if (filters.taskId) conditions.push(eq(evalRuns.taskId, filters.taskId));
  if (filters.benchmarkKey) conditions.push(eq(evalRuns.benchmarkKey, filters.benchmarkKey));
  if (filters.agentId) conditions.push(eq(evalRuns.agentId, filters.agentId));
  if (filters.modelProvider) conditions.push(eq(evalRuns.modelProvider, filters.modelProvider));
  if (filters.modelName) conditions.push(eq(evalRuns.modelName, filters.modelName));
  if (filters.status) conditions.push(eq(evalRuns.status, filters.status));
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const query = db.select().from(evalRuns);
  return conditions.length > 0
    ? query.where(and(...conditions)).orderBy(desc(evalRuns.createdAt)).limit(limit)
    : query.orderBy(desc(evalRuns.createdAt)).limit(limit);
}

function toSnapshot(row: EvalRunRow): EvalMetricsSnapshot {
  return {
    status: row.status as EvalRunStatus,
    accuracy: row.accuracy != null ? Number(row.accuracy) : null,
    latencyMs: row.latencyMs,
    cost: row.costActual != null ? Number(row.costActual) : row.costEstimated != null ? Number(row.costEstimated) : null,
  };
}

/**
 * Finds the most recent PASSED run of the same benchmark (key + version)
 * from the same provider/model, created before `run`, to use as the
 * regression comparison baseline. "Previous verified" strictly means a
 * prior run whose deterministic validators all passed — a judged_only or
 * failed run is never used as a baseline.
 */
export async function getPreviousVerifiedRun(db: Db, run: EvalRunRow): Promise<EvalRunRow | undefined> {
  const rows = await db
    .select()
    .from(evalRuns)
    .where(
      and(
        eq(evalRuns.benchmarkKey, run.benchmarkKey),
        eq(evalRuns.benchmarkVersion, run.benchmarkVersion),
        eq(evalRuns.modelProvider, run.modelProvider),
        eq(evalRuns.modelName, run.modelName),
        eq(evalRuns.status, "passed"),
        ne(evalRuns.id, run.id),
        lt(evalRuns.createdAt, run.createdAt),
      ),
    )
    .orderBy(desc(evalRuns.createdAt))
    .limit(1);
  return rows[0];
}

export type RunRegressionReport = {
  currentRunId: string;
  previousRunId: string | null;
  findings: RegressionFinding[];
};

export async function computeRegressionForRun(
  db: Db,
  runId: string,
  thresholds?: RegressionThresholds,
): Promise<RunRegressionReport | null> {
  const current = await getEvalRun(db, runId);
  if (!current) return null;
  const previous = await getPreviousVerifiedRun(db, current);
  if (!previous) return { currentRunId: current.id, previousRunId: null, findings: [] };
  const findings = detectRunRegression(toSnapshot(previous), toSnapshot(current), thresholds);
  return { currentRunId: current.id, previousRunId: previous.id, findings };
}

export type BenchmarkSummaryEntry = {
  benchmarkKey: string;
  benchmarkVersion: number;
  modelProvider: string;
  modelName: string;
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  passRate: number;
  latestStatus: EvalRunStatus | null;
  latestRunId: string | null;
  latestRunAt: string | null;
};

/**
 * One row per (benchmarkKey, benchmarkVersion, provider, model) combination
 * observed in eval_runs — this is the whole GET /api/evals/summary payload
 * (no per-run detail here; see listEvalRuns/getEvalRun for that).
 */
export async function getEvalSummary(db: Db, benchmarkKey?: string): Promise<BenchmarkSummaryEntry[]> {
  const rows = await db
    .select({
      benchmarkKey: evalRuns.benchmarkKey,
      benchmarkVersion: evalRuns.benchmarkVersion,
      modelProvider: evalRuns.modelProvider,
      modelName: evalRuns.modelName,
      totalRuns: sql<number>`count(*)::int`,
      passedRuns: sql<number>`count(*) filter (where ${evalRuns.status} = 'passed')::int`,
      failedRuns: sql<number>`count(*) filter (where ${evalRuns.status} = 'failed')::int`,
      latestRunId: sql<string>`(array_agg(${evalRuns.id} order by ${evalRuns.createdAt} desc))[1]`,
      latestStatus: sql<string>`(array_agg(${evalRuns.status} order by ${evalRuns.createdAt} desc))[1]`,
      latestRunAt: sql<string>`(array_agg(${evalRuns.createdAt} order by ${evalRuns.createdAt} desc))[1]`,
    })
    .from(evalRuns)
    .where(benchmarkKey ? eq(evalRuns.benchmarkKey, benchmarkKey) : sql`true`)
    .groupBy(evalRuns.benchmarkKey, evalRuns.benchmarkVersion, evalRuns.modelProvider, evalRuns.modelName);

  return rows.map((r) => ({
    benchmarkKey: r.benchmarkKey,
    benchmarkVersion: r.benchmarkVersion,
    modelProvider: r.modelProvider,
    modelName: r.modelName,
    totalRuns: r.totalRuns,
    passedRuns: r.passedRuns,
    failedRuns: r.failedRuns,
    passRate: r.totalRuns > 0 ? r.passedRuns / r.totalRuns : 0,
    latestStatus: (r.latestStatus as EvalRunStatus) ?? null,
    latestRunId: r.latestRunId ?? null,
    latestRunAt: r.latestRunAt ?? null,
  }));
}

export type AgentEvalSummary = {
  agentId: string;
  latestEval: EvalRunRow | null;
  passRate: number | null;
  avgLatencyMs: number | null;
  avgCost: number | null;
  recentRegression: RunRegressionReport | null;
  recentRuns: EvalRunRow[];
};

/**
 * Server-computed eval summary for one agent — averages/pass-rate are
 * computed here, over every run the agent has, specifically so the
 * frontend never has to. `recentRuns` (default last 10) is a display
 * slice; `passRate`/`avgLatencyMs`/`avgCost` are computed over the
 * agent's FULL run history, not just that slice, so they are not skewed
 * by the display limit. Empty state (agent has never run an eval): not an
 * error — returns nulls/empty array, since this service does not own
 * whether the agentId itself is a valid, existing agent.
 */
export async function getAgentEvalSummary(
  db: Db,
  agentId: string,
  recentRunsLimit = 10,
): Promise<AgentEvalSummary> {
  const [agg] = await db
    .select({
      totalRuns: sql<number>`count(*)::int`,
      passedRuns: sql<number>`count(*) filter (where ${evalRuns.status} = 'passed')::int`,
      avgLatencyMs: sql<string | null>`avg(${evalRuns.latencyMs})`,
      avgCost: sql<string | null>`avg(coalesce(${evalRuns.costActual}, ${evalRuns.costEstimated}))`,
    })
    .from(evalRuns)
    .where(eq(evalRuns.agentId, agentId));

  const recentRuns = await listEvalRuns(db, { agentId, limit: recentRunsLimit });
  const latestEval = recentRuns[0] ?? null;
  const recentRegression = latestEval ? await computeRegressionForRun(db, latestEval.id) : null;

  const totalRuns = agg?.totalRuns ?? 0;
  return {
    agentId,
    latestEval,
    passRate: totalRuns > 0 ? (agg?.passedRuns ?? 0) / totalRuns : null,
    avgLatencyMs: agg?.avgLatencyMs != null ? Number(agg.avgLatencyMs) : null,
    avgCost: agg?.avgCost != null ? Number(agg.avgCost) : null,
    recentRegression,
    recentRuns,
  };
}
