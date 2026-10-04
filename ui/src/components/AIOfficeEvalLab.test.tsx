// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIOfficeEvalLab, EvalStatusBadge } from "./AIOfficeEvalLab";
import type {
  BenchmarkCase,
  BenchmarkSummaryEntry,
  EvalRunSummary,
} from "../api/evals";

const mockEvalsApi = vi.hoisted(() => ({
  listBenchmarks: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  getSummary: vi.fn(),
  getAgentSummary: vi.fn(),
}));

vi.mock("../api/evals", () => ({
  evalsApi: mockEvalsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

const SAMPLE_BENCHMARKS: BenchmarkCase[] = [
  {
    id: "bench-1",
    key: "sql-query-fix",
    version: 1,
    name: "Fix a broken SQL query",
    description: "Diagnostic SQL fix",
    category: "database",
    active: true,
    validatorSpec: [{ type: "test_result", minPassRate: 1 }],
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  },
  {
    id: "bench-2",
    key: "react-hook-debug",
    version: 1,
    name: "Debug React Hook leak",
    description: "Memory leak in useEffect",
    category: "frontend",
    active: true,
    validatorSpec: [{ type: "test_result", minPassRate: 1 }],
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  },
];

const SAMPLE_SUMMARY: BenchmarkSummaryEntry[] = [
  {
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    modelProvider: "anthropic",
    modelName: "claude-sonnet-5",
    totalRuns: 10,
    passedRuns: 9,
    failedRuns: 1,
    passRate: 0.9,
    latestStatus: "passed",
    latestRunId: "run-c1",
    latestRunAt: "2026-09-30T01:00:00.000Z",
  },
  {
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    modelProvider: "openai",
    modelName: "gpt-5-codex",
    totalRuns: 10,
    passedRuns: 8,
    failedRuns: 2,
    passRate: 0.8,
    latestStatus: "failed",
    latestRunId: "run-o1",
    latestRunAt: "2026-09-30T02:00:00.000Z",
  },
  {
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    modelProvider: "google",
    modelName: "gemini-2.5-pro",
    totalRuns: 10,
    passedRuns: 9,
    failedRuns: 1,
    passRate: 0.9,
    latestStatus: "passed",
    latestRunId: "run-g1",
    latestRunAt: "2026-09-30T03:00:00.000Z",
  },
  {
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    modelProvider: "nous",
    modelName: "hermes-3-70b",
    totalRuns: 10,
    passedRuns: 7,
    failedRuns: 3,
    passRate: 0.7,
    latestStatus: "judged_only",
    latestRunId: "run-h1",
    latestRunAt: "2026-09-30T04:00:00.000Z",
  },
];

const SAMPLE_RUNS: EvalRunSummary[] = [
  {
    id: "run-c1",
    taskId: "bench-1",
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    agentId: "agent-1",
    modelProvider: "anthropic",
    modelName: "claude-sonnet-5",
    status: "passed",
    startedAt: "2026-09-30T01:00:00.000Z",
    completedAt: "2026-09-30T01:00:04.200Z",
    success: "true",
    accuracy: 0.95,
    latencyMs: 3500,
    tokenUsage: { input: 1000, output: 250, total: 1250 },
    costEstimated: 0.012,
    costActual: 0.0115,
    failureType: null,
    retryCount: 0,
    retryOfRunId: null,
    createdAt: "2026-09-30T01:00:00.000Z",
  },
  {
    id: "run-o1",
    taskId: "bench-1",
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    agentId: "agent-2",
    modelProvider: "openai",
    modelName: "gpt-5-codex",
    status: "failed",
    startedAt: "2026-09-30T02:00:00.000Z",
    completedAt: "2026-09-30T02:00:05.100Z",
    success: "false",
    accuracy: 0.6,
    latencyMs: 5100,
    tokenUsage: { input: 1200, output: 400, total: 1600 },
    costEstimated: 0.015,
    costActual: 0.0148,
    failureType: "assertion_failure",
    retryCount: 0,
    retryOfRunId: null,
    createdAt: "2026-09-30T02:00:00.000Z",
  },
  {
    id: "run-h1",
    taskId: "bench-1",
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    agentId: "agent-3",
    modelProvider: "nous",
    modelName: "hermes-3-70b",
    status: "judged_only",
    startedAt: "2026-09-30T04:00:00.000Z",
    completedAt: "2026-09-30T04:00:02.800Z",
    success: null,
    accuracy: 0.8,
    latencyMs: 2800,
    tokenUsage: null,
    costEstimated: 0.002,
    costActual: null,
    failureType: null,
    retryCount: 0,
    retryOfRunId: null,
    createdAt: "2026-09-30T04:00:00.000Z",
  },
];

describe("AIOfficeEvalLab", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockEvalsApi.listBenchmarks.mockResolvedValue({ benchmarks: SAMPLE_BENCHMARKS });
    mockEvalsApi.getSummary.mockResolvedValue({ summary: SAMPLE_SUMMARY });
    mockEvalsApi.listRuns.mockImplementation((params?: { status?: string }) => {
      if (params?.status === "failed") {
        return Promise.resolve({
          runs: SAMPLE_RUNS.filter((r) => r.status === "failed"),
        });
      }
      return Promise.resolve({ runs: SAMPLE_RUNS });
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderComponent(agentNameById?: Map<string, string>) {
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AIOfficeEvalLab agentNameById={agentNameById} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("renders header and quality summary cards", async () => {
    await renderComponent();

    expect(container.textContent).toContain("Control Center — Agent Quality & Simulation Lab (F-04)");
    expect(container.textContent).toContain("전체 실행");
    expect(container.textContent).toContain("40"); // 10 * 4
    expect(container.textContent).toContain("평균 성공률");
    expect(container.textContent).toContain("82.5%"); // 33 / 40 * 100
    expect(container.textContent).toContain("실패율");
    expect(container.textContent).toContain("17.5%"); // 7 / 40 * 100
    expect(container.textContent).toContain("활성 벤치마크");
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("최근 실패 건수");
    expect(container.textContent).toContain("1");
  });

  it("renders benchmark model comparison table across Claude, GPT, Gemini, and Hermes", async () => {
    await renderComponent();

    expect(container.textContent).toContain("Benchmark 모델 비교 (Claude vs GPT vs Gemini vs Hermes)");
    expect(container.textContent).toContain("claude-sonnet-5");
    expect(container.textContent).toContain("gpt-5-codex");
    expect(container.textContent).toContain("gemini-2.5-pro");
    expect(container.textContent).toContain("hermes-3-70b");

    // Success rates
    expect(container.textContent).toContain("90.0%");
    expect(container.textContent).toContain("80.0%");
    expect(container.textContent).toContain("70.0%");
  });

  it("renders judged_only status distinctly from passed and never treats it as verified", async () => {
    await renderComponent();

    // Hermes has status judged_only
    expect(container.textContent).toContain("판정 전용 (검증 미완료)");
  });

  it("renders regression alert when failed runs exist", async () => {
    await renderComponent();

    expect(container.textContent).toContain("Regression Alerts (회귀 감지 알림)");
    expect(container.textContent).toContain("[openai/gpt-5-codex]");
    expect(container.textContent).toContain("assertion_failure");
  });

  it("renders clean regression alert when no failed runs exist", async () => {
    mockEvalsApi.listRuns.mockImplementation((params?: { status?: string }) => {
      if (params?.status === "failed") {
        return Promise.resolve({ runs: [] });
      }
      return Promise.resolve({ runs: SAMPLE_RUNS });
    });

    await renderComponent();

    expect(container.textContent).toContain(
      "최근 감지된 모델 품질 회귀 또는 실행 실패가 없습니다. (안정 상태)",
    );
  });

  it("resolves agent name from agentNameById map in recent runs table", async () => {
    const nameMap = new Map<string, string>([
      ["agent-1", "JARVIS"],
      ["agent-2", "Atlas"],
    ]);

    await renderComponent(nameMap);

    expect(container.textContent).toContain("JARVIS");
    expect(container.textContent).toContain("Atlas");
    expect(container.textContent).toContain("최근 Eval 실행 내역 (3건)");
    expect(container.textContent).toContain("$0.0115");
    expect(container.textContent).toContain("3500ms");
  });

  it("renders empty state messages when no data exists", async () => {
    mockEvalsApi.getSummary.mockResolvedValue({ summary: [] });
    mockEvalsApi.listRuns.mockResolvedValue({ runs: [] });
    mockEvalsApi.listBenchmarks.mockResolvedValue({ benchmarks: [] });

    await renderComponent();

    expect(container.textContent).toContain("벤치마크 평가 요약 데이터가 아직 등록되지 않았습니다.");
    expect(container.textContent).toContain("실행된 Eval 내역이 없습니다.");
  });

  it("displays graceful error banner on API failure", async () => {
    mockEvalsApi.getSummary.mockRejectedValue(new Error("Network Error"));
    mockEvalsApi.listRuns.mockRejectedValue(new Error("Network Error"));
    mockEvalsApi.listBenchmarks.mockRejectedValue(new Error("Network Error"));

    await renderComponent();

    expect(container.textContent).toContain("Eval 데이터를 불러올 수 없습니다.");
  });
});

describe("EvalStatusBadge", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it.each([
    ["passed", "통과"],
    ["failed", "실패"],
    ["error", "오류"],
    ["judged_only", "판정 전용 (검증 미완료)"],
    ["running", "실행 중"],
    ["queued", "대기"],
  ] as const)("renders %s status with label %s", (status, label) => {
    const root = createRoot(container);
    act(() => {
      root.render(<EvalStatusBadge status={status} />);
    });
    expect(container.textContent).toContain(label);
  });
});
