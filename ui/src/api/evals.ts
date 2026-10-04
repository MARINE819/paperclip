import { api } from "./client";

export type EvalRunStatus = "queued" | "running" | "passed" | "failed" | "error" | "judged_only";

export interface BenchmarkCase {
  id: string;
  key: string;
  version: number;
  name: string;
  description: string | null;
  category: string;
  active: boolean;
  validatorSpec: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
}

export interface EvalRunSummary {
  id: string;
  taskId: string;
  benchmarkKey: string;
  benchmarkVersion: number;
  agentId: string | null;
  modelProvider: string;
  modelName: string;
  status: EvalRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  success: "true" | "false" | null;
  accuracy: number | null;
  latencyMs: number | null;
  tokenUsage: { input?: number; output?: number; total?: number } | null;
  costEstimated: number | null;
  costActual: number | null;
  failureType: string | null;
  retryCount: number;
  retryOfRunId: string | null;
  createdAt: string;
}

export interface RegressionFinding {
  kind: "accuracy_degradation" | "failure_rate_increase" | "latency_increase" | "cost_increase";
  previous: number | string;
  current: number | string;
  message: string;
}

export interface RunRegressionReport {
  currentRunId: string;
  previousRunId: string | null;
  findings: RegressionFinding[];
}

export interface ValidatorResult {
  type: string;
  deterministic: boolean;
  passed: boolean;
  details?: string;
  expected?: unknown;
  actual?: unknown;
  score?: number;
  rationale?: string;
}

export interface EvalRunDetail extends EvalRunSummary {
  evidence?: Record<string, unknown>[];
  validatorResults?: ValidatorResult[];
}

export interface BenchmarkSummaryEntry {
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
}

export interface AgentEvalSummary {
  agentId: string;
  latestEval: EvalRunSummary | null;
  passRate: number | null;
  avgLatencyMs: number | null;
  avgCost: number | null;
  recentRegression: RunRegressionReport | null;
  recentRuns: EvalRunSummary[];
}

export const evalsApi = {
  listBenchmarks: (params?: { activeOnly?: boolean; category?: string }) => {
    const q = new URLSearchParams();
    if (params?.activeOnly !== undefined) q.set("activeOnly", String(params.activeOnly));
    if (params?.category) q.set("category", params.category);
    const qs = q.toString();
    return api.get<{ benchmarks: BenchmarkCase[] }>(`/evals/benchmarks${qs ? `?${qs}` : ""}`);
  },

  listRuns: (params?: {
    taskId?: string;
    benchmarkKey?: string;
    agentId?: string;
    modelProvider?: string;
    modelName?: string;
    status?: EvalRunStatus;
    limit?: number;
  }) => {
    const q = new URLSearchParams();
    if (params?.taskId) q.set("taskId", params.taskId);
    if (params?.benchmarkKey) q.set("benchmarkKey", params.benchmarkKey);
    if (params?.agentId) q.set("agentId", params.agentId);
    if (params?.modelProvider) q.set("modelProvider", params.modelProvider);
    if (params?.modelName) q.set("modelName", params.modelName);
    if (params?.status) q.set("status", params.status);
    if (params?.limit !== undefined) q.set("limit", String(params.limit));
    const qs = q.toString();
    return api.get<{ runs: EvalRunSummary[] }>(`/evals/runs${qs ? `?${qs}` : ""}`);
  },

  getRun: (runId: string) =>
    api.get<{ run: EvalRunDetail; regression: RunRegressionReport }>(`/evals/runs/${runId}`),

  getSummary: (params?: { benchmarkKey?: string }) => {
    const q = new URLSearchParams();
    if (params?.benchmarkKey) q.set("benchmarkKey", params.benchmarkKey);
    const qs = q.toString();
    return api.get<{ summary: BenchmarkSummaryEntry[] }>(`/evals/summary${qs ? `?${qs}` : ""}`);
  },

  getAgentSummary: (agentId: string, params?: { recentRunsLimit?: number }) => {
    const q = new URLSearchParams();
    if (params?.recentRunsLimit !== undefined) q.set("recentRunsLimit", String(params.recentRunsLimit));
    const qs = q.toString();
    return api.get<{ agent: AgentEvalSummary }>(`/evals/agents/${agentId}/summary${qs ? `?${qs}` : ""}`);
  },
};
