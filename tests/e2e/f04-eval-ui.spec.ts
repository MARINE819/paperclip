import { expect, test, type APIRequestContext } from "@playwright/test";

// NEXORA F-04 — Agent Eval & Simulation Lab Browser E2E verification
// Tests end-to-end:
// 1. Live page load on /ai-office
// 2. Control Center Eval Lab summary render (quality cards, benchmark comparison grid, regression alerts, runs)
// 3. Agent detail sheet opening on workstation click with F-04 quality metrics
// 4. Empty state graceful handling
// 5. API error graceful handling
// 6. Reload stability
// 7. 0 console errors & 0 page errors

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", {
    data: { name: `F04 Eval UI ${label} ${Date.now()}` },
  });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

const MOCK_SUMMARY = [
  {
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    modelProvider: "anthropic",
    modelName: "claude-sonnet-5",
    totalRuns: 20,
    passedRuns: 19,
    failedRuns: 1,
    passRate: 0.95,
    latestStatus: "passed",
    latestRunId: "run-claude-1",
    latestRunAt: new Date().toISOString(),
  },
  {
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    modelProvider: "openai",
    modelName: "gpt-5-codex",
    totalRuns: 20,
    passedRuns: 16,
    failedRuns: 4,
    passRate: 0.8,
    latestStatus: "failed",
    latestRunId: "run-gpt-1",
    latestRunAt: new Date().toISOString(),
  },
  {
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    modelProvider: "google",
    modelName: "gemini-2.5-pro",
    totalRuns: 20,
    passedRuns: 18,
    failedRuns: 2,
    passRate: 0.9,
    latestStatus: "passed",
    latestRunId: "run-gemini-1",
    latestRunAt: new Date().toISOString(),
  },
  {
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    modelProvider: "nous",
    modelName: "hermes-3-70b",
    totalRuns: 20,
    passedRuns: 15,
    failedRuns: 5,
    passRate: 0.75,
    latestStatus: "judged_only",
    latestRunId: "run-hermes-1",
    latestRunAt: new Date().toISOString(),
  },
];

const MOCK_BENCHMARKS = [
  {
    id: "bench-1",
    key: "sql-query-fix",
    version: 1,
    name: "Fix a broken SQL query",
    description: "Database diagnostic test",
    category: "database",
    active: true,
    validatorSpec: [{ type: "test_result", minPassRate: 1 }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const MOCK_RUNS = [
  {
    id: "run-claude-1",
    taskId: "bench-1",
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    agentId: null,
    modelProvider: "anthropic",
    modelName: "claude-sonnet-5",
    status: "passed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    success: "true",
    accuracy: 0.96,
    latencyMs: 3120,
    tokenUsage: { input: 1200, output: 300, total: 1500 },
    costEstimated: 0.012,
    costActual: 0.0118,
    failureType: null,
    retryCount: 0,
    retryOfRunId: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: "run-gpt-1",
    taskId: "bench-1",
    benchmarkKey: "sql-query-fix",
    benchmarkVersion: 1,
    agentId: null,
    modelProvider: "openai",
    modelName: "gpt-5-codex",
    status: "failed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    success: "false",
    accuracy: 0.55,
    latencyMs: 4800,
    tokenUsage: { input: 1300, output: 420, total: 1720 },
    costEstimated: 0.016,
    costActual: 0.0155,
    failureType: "assertion_failure",
    retryCount: 0,
    retryOfRunId: null,
    createdAt: new Date().toISOString(),
  },
];

test.describe("NEXORA F-04 Agent Eval & Simulation Lab UI", () => {
  test.setTimeout(120_000);

  let seed: Seed;
  let jarvisAgentId: string;

  test.beforeAll(async ({ request }) => {
    seed = await newCompany(request, "eval-ui");

    const agentRes = await request.post(`/api/companies/${seed.companyId}/agents`, {
      data: {
        name: "JARVIS",
        role: "ceo",
        title: "CTO / Orchestrator",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      },
    });
    expect(agentRes.ok(), `create JARVIS failed ${agentRes.status()}: ${await agentRes.text()}`).toBe(true);
    const agent = await agentRes.json();
    jarvisAgentId = agent.id as string;
  });

  test("renders summary, model comparison, agent detail, handles empty/error, 0 errors, survives reload", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        // Exclude intentional 500 mock fetch failures from browser console errors if logged by client
        const text = msg.text();
        if (!text.includes("/api/evals/summary") && !text.includes("Failed to load resource")) {
          consoleErrors.push(text);
        }
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // 1. Intercept evals API to supply benchmark data
    await page.route("**/api/evals/summary**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ summary: MOCK_SUMMARY }),
      });
    });

    await page.route("**/api/evals/benchmarks**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ benchmarks: MOCK_BENCHMARKS }),
      });
    });

    await page.route("**/api/evals/runs**", async (route) => {
      const url = route.request().url();
      if (url.includes("status=failed")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ runs: MOCK_RUNS.filter((r) => r.status === "failed") }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ runs: MOCK_RUNS }),
        });
      }
    });

    await page.route(`**/api/evals/agents/${jarvisAgentId}/summary**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agent: {
            agentId: jarvisAgentId,
            latestEval: MOCK_RUNS[0],
            passRate: 0.95,
            avgLatencyMs: 3120,
            avgCost: 0.0118,
            recentRegression: {
              currentRunId: "run-claude-1",
              previousRunId: null,
              findings: [],
            },
            recentRuns: [MOCK_RUNS[0]],
          },
        }),
      });
    });

    // 2. Navigate to AI Office
    await page.goto(`/${seed.prefix}/ai-office?tab=quality`);
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });

    // 3. Verify Control Center Eval Lab component loaded
    const evalHeader = page.getByText("Control Center — Agent Quality & Simulation Lab (F-04)");
    await expect(evalHeader).toBeVisible({ timeout: 15_000 });

    // Verify Agent Quality Summary cards
    await expect(page.getByText("전체 실행")).toBeVisible();
    await expect(page.getByText("평균 성공률")).toBeVisible();
    await expect(page.getByText("활성 벤치마크")).toBeVisible();
    await expect(page.getByText("최근 실패 건수")).toBeVisible();

    // Verify Benchmark Model Comparison Grid
    await expect(page.getByText("Benchmark 모델 비교 (Claude vs GPT vs Gemini vs Hermes)")).toBeVisible();
    await expect(page.getByRole("cell", { name: "claude-sonnet-5", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "gpt-5-codex", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "gemini-2.5-pro", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "hermes-3-70b", exact: true })).toBeVisible();

    // Verify judged_only status is distinctly rendered (not "통과")
    await expect(page.getByText("판정 전용 (검증 미완료)")).toBeVisible();

    // Verify Regression Alerts Bar shows failed run alert
    await expect(page.getByText("Regression Alerts (회귀 감지 알림)")).toBeVisible();
    await expect(page.getByText("[openai/gpt-5-codex]")).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f04-eval-01-loaded.png`, fullPage: true });

    // 4. Test Provider Filter Buttons
    const anthropicBtn = page.getByRole("button", { name: "anthropic" });
    if (await anthropicBtn.isVisible()) {
      await anthropicBtn.click();
      await expect(page.getByRole("cell", { name: "claude-sonnet-5", exact: true })).toBeVisible();
      const allBtn = page.getByRole("button", { name: "전체" });
      await allBtn.click();
    }

    // 5. Test Agent Detail Sheet (AI Office Floor integration)
    const jarvisSeat = main.getByRole("button", { name: /JARVIS/ });
    await expect(jarvisSeat).toBeVisible({ timeout: 10_000 });
    await jarvisSeat.click();

    // Verify Agent Detail Sheet opens and shows F-04 quality metrics
    const detailSheet = page.locator("[role='dialog']");
    await expect(detailSheet.getByText("F-04 품질 평가 (Agent Eval)")).toBeVisible({ timeout: 10_000 });
    await expect(detailSheet.getByText("sql-query-fix (v1)")).toBeVisible();
    await expect(detailSheet.getByText("95.0%")).toBeVisible(); // passRate
    await expect(detailSheet.getByText("3120ms")).toBeVisible(); // avgLatencyMs
    await expect(detailSheet.getByText("$0.0118")).toBeVisible(); // avgCost
    await expect(detailSheet.getByText("회귀 없음 (정상)")).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f04-eval-02-agent-detail.png`, fullPage: true });

    // Close detail sheet by pressing Escape or clicking outside
    await page.keyboard.press("Escape");
    await expect(detailSheet).not.toBeVisible({ timeout: 5000 });

    // 6. Test Empty State Handling
    await page.unroute("**/api/evals/summary**");
    await page.unroute("**/api/evals/runs**");
    await page.unroute("**/api/evals/benchmarks**");

    await page.route("**/api/evals/summary**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ summary: [] }),
      });
    });
    await page.route("**/api/evals/runs**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
    });
    await page.route("**/api/evals/benchmarks**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ benchmarks: [] }),
      });
    });

    const refreshBtn = page.getByRole("button", { name: /새로고침/ });
    await refreshBtn.click();

    await expect(page.getByText("벤치마크 평가 요약 데이터가 아직 등록되지 않았습니다.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("실행된 Eval 내역이 없습니다.")).toBeVisible();
    await expect(
      page.getByText("최근 감지된 모델 품질 회귀 또는 실행 실패가 없습니다. (안정 상태)"),
    ).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f04-eval-03-empty-state.png`, fullPage: true });

    // 7. Test API Error Graceful Handling
    await page.unroute("**/api/evals/summary**");
    await page.route("**/api/evals/summary**", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal Server Error" }),
      });
    });

    await refreshBtn.click();
    await expect(page.getByText("Eval 데이터를 불러올 수 없습니다.")).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f04-eval-04-api-error.png`, fullPage: true });

    // 8. Test Reload Stability
    // Restore normal mock routes before reload
    await page.unroute("**/api/evals/summary**");
    await page.route("**/api/evals/summary**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ summary: MOCK_SUMMARY }),
      });
    });

    await page.reload();
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Control Center — Agent Quality & Simulation Lab (F-04)")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("cell", { name: "claude-sonnet-5", exact: true })).toBeVisible();

    // 9. Assert 0 unhandled console errors and 0 page errors
    expect(pageErrors, `uncaught page errors: ${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toHaveLength(0);
  });
});
