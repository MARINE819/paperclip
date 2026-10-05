import { expect, test, type APIRequestContext } from "@playwright/test";

// NEXORA F-06 — Incident & SRE Control Center Browser E2E verification
// Tests end-to-end:
// 1. Live page load on /ai-office
// 2. Incident Summary Cards (Open, Recovering, Resolved, Critical/High, Failure Memory)
// 3. Active Incidents card/table with detector labels and badges
// 4. Incident detail dialog interaction (open, verify fields, close)
// 5. Historical / Resolved collapsible incidents
// 6. Empty state graceful handling
// 7. API error graceful handling
// 8. Reload stability
// 9. 0 console errors & 0 page errors

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", {
    data: { name: `F06 Incident UI ${label} ${Date.now()}` },
  });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

const MOCK_OPEN_INCIDENTS = [
  {
    id: "inc-open-1",
    code: "windows_control_c_exit_detected",
    severity: "medium",
    status: "recovering",
    affectedComponents: ["server"],
    detectedAt: "2026-09-30T09:03:35.623Z",
    lastObservedAt: "2026-09-30T11:49:54.162Z",
    resolvedAt: null,
    occurrenceCount: 10,
    recoveryAttempted: true,
    recoveryResult: "succeeded",
    rootCauseStatus: "unknown",
    failureMemoryCandidate: false,
    fingerprint: "windows-exit-3221225786",
    evidence: [{ exitCode: 3221225786, signal: "SIGINT" }],
  },
  {
    id: "inc-open-2",
    code: "runtime_duplicate_detected",
    severity: "critical",
    status: "open",
    affectedComponents: ["server", "supervisor"],
    detectedAt: "2026-09-30T10:00:00.000Z",
    lastObservedAt: "2026-09-30T10:05:00.000Z",
    resolvedAt: null,
    occurrenceCount: 3,
    recoveryAttempted: false,
    recoveryResult: null,
    rootCauseStatus: "investigating",
    failureMemoryCandidate: true,
    fingerprint: "duplicate-runtime-pid-4321",
    evidence: [{ conflictingPids: [1234, 4321], port: 3100 }],
  },
];

const MOCK_RESOLVED_INCIDENTS = [
  {
    id: "inc-res-1",
    code: "runtime_restart_loop",
    severity: "high",
    status: "resolved",
    affectedComponents: ["server"],
    detectedAt: "2026-09-30T08:00:00.000Z",
    lastObservedAt: "2026-09-30T08:15:00.000Z",
    resolvedAt: "2026-09-30T08:20:00.000Z",
    occurrenceCount: 4,
    recoveryAttempted: true,
    recoveryResult: "succeeded",
    rootCauseStatus: "known",
    failureMemoryCandidate: true,
    fingerprint: "restart-loop-crash",
    evidence: [{ restartCount: 4, windowSeconds: 900 }],
  },
];

test.describe("NEXORA F-06 Incident & SRE Control Center UI", () => {
  test.setTimeout(120_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await newCompany(request, "incident-ui");

    const agentRes = await request.post(`/api/companies/${seed.companyId}/agents`, {
      data: {
        name: "JARVIS",
        role: "ceo",
        title: "CTO / Orchestrator",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      },
    });
    expect(agentRes.ok(), `create agent failed ${agentRes.status()}: ${await agentRes.text()}`).toBe(true);
  });

  test("renders summary cards, active incidents table, detail dialog, handles empty/error states, survives reload with 0 errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (!text.includes("/api/instance/incidents") && !text.includes("Failed to load resource")) {
          consoleErrors.push(text);
        }
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // 1. Intercept incidents API
    await page.route("**/api/instance/incidents**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          open: MOCK_OPEN_INCIDENTS,
          resolved: MOCK_RESOLVED_INCIDENTS,
        }),
      });
    });

    // 2. Navigate to AI Office
    await page.goto(`/${seed.prefix}/ai-office`);
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });

    // 3. Verify Control Center Incident Lab component loaded
    const incidentHeader = page.getByText("Control Center — Incident & SRE Center (F-06)");
    await expect(incidentHeader).toBeVisible({ timeout: 15_000 });
    const incidentLab = incidentHeader.locator("xpath=ancestor::div[contains(@class, 'space-y-4')][1]");

    // 4. Verify Incident Summary Cards
    const summaryCards = incidentLab.locator(".grid.grid-cols-2.gap-3.sm\\:grid-cols-5");
    await expect(summaryCards).toBeVisible();
    await expect(summaryCards.getByText("활성 장애 (Open)")).toBeVisible();
    await expect(summaryCards.getByText("복구 진행 중")).toBeVisible();
    await expect(summaryCards.getByText("해결된 장애 (Resolved)")).toBeVisible();
    await expect(summaryCards.getByText("Critical / High")).toBeVisible();
    await expect(summaryCards.getByText("Failure Memory 후보", { exact: true })).toBeVisible();

    // Verify Summary Card Numbers
    await expect(summaryCards.getByText("1").first()).toBeVisible();
    await expect(summaryCards.getByText("2").first()).toBeVisible();

    // 5. Verify Active Incidents List & Detector Descriptions
    await expect(page.getByText("Windows 0xC000013A (Control-C) 프로세스 비정상 종료")).toBeVisible();
    await expect(page.getByText("중복 런타임 프로세스 감지 (포트/PID 경합)")).toBeVisible();

    // Verify Badges
    await expect(page.getByText("복구 중 (Recovering)")).toBeVisible();
    await expect(page.getByText("열림 (Open)")).toBeVisible();
    await expect(page.getByText("Critical (치명)")).toBeVisible();
    await expect(page.getByText("Medium (중간)")).toBeVisible();
    await expect(page.getByText("원인 미확인 (UNKNOWN)")).toBeVisible();
    await expect(page.getByText("조사 중")).toBeVisible();

    // Verify Occurrence Counts
    await expect(incidentLab.getByText("10회").first()).toBeVisible();
    await expect(incidentLab.getByText("3회").first()).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f06-incident-01-loaded.png`, fullPage: true });

    // 6. Test Incident Detail Dialog
    const detailButtons = incidentLab.getByRole("button", { name: "상세 보기" });
    await expect(detailButtons.first()).toBeVisible();
    await detailButtons.first().click();

    // Verify Dialog content
    const detailDialog = page.locator("[role='dialog']");
    await expect(detailDialog.getByText("Incident 상세 정보")).toBeVisible({ timeout: 10_000 });
    await expect(detailDialog.getByText("windows-exit-3221225786")).toBeVisible();
    await expect(detailDialog.getByText("10회 반복")).toBeVisible();
    await expect(detailDialog.getByText("시도됨")).toBeVisible();
    await expect(detailDialog.getByText("succeeded")).toBeVisible();
    await expect(detailDialog.locator("pre").getByText("3221225786")).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f06-incident-02-detail-dialog.png`, fullPage: true });

    // Close Dialog by pressing Escape
    await page.keyboard.press("Escape");
    await expect(detailDialog).not.toBeVisible({ timeout: 5000 });

    // 7. Test Historical / Resolved Collapsible Section
    await expect(incidentLab.getByText("과거 해결된 Incident 내역 (1건)")).toBeVisible();
    const resolvedToggle = incidentLab.getByRole("button", { name: /내역 보기/ });
    await expect(resolvedToggle).toBeVisible();
    await resolvedToggle.click();

    // Verify resolved item rendered
    await expect(incidentLab.getByText("런타임 재시작 루프 감지 (15분 내 3회 이상)")).toBeVisible();
    await expect(incidentLab.getByText("4회").first()).toBeVisible();
    await expect(incidentLab.getByText("후보 등록").first()).toBeVisible();

    // 8. Test Empty State Handling
    await page.unroute("**/api/instance/incidents**");
    await page.route("**/api/instance/incidents**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ open: [], resolved: [] }),
      });
    });

    const refreshBtn = incidentLab.getByRole("button", { name: /새로고침/ });
    await refreshBtn.click();

    await expect(page.getByText("현재 열린 Incident 없음")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("모든 시스템 런타임 및 Supervisor가 정상 가동 중이며 감지된 장애가 없습니다.")).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f06-incident-03-empty-state.png`, fullPage: true });

    // 9. Test API Error State Handling
    await page.unroute("**/api/instance/incidents**");
    await page.route("**/api/instance/incidents**", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal Server Error" }),
      });
    });

    await refreshBtn.click();
    await expect(page.getByText("Incident 데이터를 불러올 수 없습니다.")).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f06-incident-04-api-error.png`, fullPage: true });

    // 10. Test Reload Stability
    await page.unroute("**/api/instance/incidents**");
    await page.route("**/api/instance/incidents**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          open: MOCK_OPEN_INCIDENTS,
          resolved: MOCK_RESOLVED_INCIDENTS,
        }),
      });
    });

    await page.reload();
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Control Center — Incident & SRE Center (F-06)")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Windows 0xC000013A (Control-C) 프로세스 비정상 종료")).toBeVisible();

    // 11. Assert 0 uncaught console errors and 0 page errors
    expect(pageErrors, `uncaught page errors: ${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toHaveLength(0);
  });
});
