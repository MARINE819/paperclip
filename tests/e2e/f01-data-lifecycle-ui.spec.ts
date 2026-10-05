import { expect, test, type APIRequestContext } from "@playwright/test";

// NEXORA F-01 — Data Lifecycle Control Center Browser E2E verification
// Tests end-to-end:
// 1. Live page load on /ai-office
// 2. Control Center Data Lifecycle Lab header & description (F-01)
// 3. Top Summary Cards (전체 Data Class: 12, 정책 설정됨: 2, 정책 미설정: 10, Legal Hold: 1, 미매핑: 1)
// 4. Data Class Overview Table with 12 classes & classification statuses (mapped, unmapped, file_based)
// 5. Special class inspections:
//    - audit & activityLog: mapped tables, retention policies, legal hold badges
//    - memory_summary: honestly unmapped status & explanatory notes
//    - backup_metadata: file_based classification & filesystem directory source
//    - verified_knowledge: archivedAt 지원 badge
// 6. Read-Only Dry Run Dialog interaction (audit):
//    - Candidate count (42건 / 42행), retention target, fail-closed reason (legal_hold_active), safety notice
// 7. Read-Only Dry Run Dialog interaction (memory_summary unmapped):
//    - Fail-closed reason (unsupported_data_class), 0건 / 0행, safety notice
// 8. Empty policy state banner when 0 policies configured
// 9. API Error state graceful handling (500 internal server error)
// 10. Reload stability (page.reload())
// 11. Zero console errors & zero page errors

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", {
    data: { name: `F01 Data Lifecycle UI ${label} ${Date.now()}` },
  });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

const MOCK_CLASSIFICATIONS = [
  {
    dataClass: "audit",
    description: "General company activity/audit trail",
    status: "mapped",
    tables: [{ table: "company_audit_logs", ageColumn: "createdAt" }],
    notes: "Append-only by design",
    policy: {
      id: "p-audit",
      dataClass: "audit",
      retentionMode: "retain",
      retentionDays: 90,
      archiveAfterDays: null,
      hardDeleteAfterDays: null,
      legalHold: true,
      enabled: true,
      source: "admin_configured",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
  },
  {
    dataClass: "secret_audit",
    description: "F-02 secret access events",
    status: "mapped",
    tables: [{ table: "secret_access_events", ageColumn: "createdAt" }],
    notes: "Secret audit logs",
    policy: {
      id: "p-secret",
      dataClass: "secret_audit",
      retentionMode: "delete",
      retentionDays: 30,
      archiveAfterDays: null,
      hardDeleteAfterDays: null,
      legalHold: false,
      enabled: false,
      source: "admin_configured",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    },
  },
  {
    dataClass: "runtime",
    description: "Runtime heartbeat execution history",
    status: "mapped",
    tables: [{ table: "heartbeat_runs", ageColumn: "createdAt" }],
    notes: "Agent heartbeat runs",
    policy: null,
  },
  {
    dataClass: "task",
    description: "Issues and tasks",
    status: "mapped",
    tables: [{ table: "issues", ageColumn: "createdAt" }],
    notes: "Project tasks",
    policy: null,
  },
  {
    dataClass: "approval",
    description: "Approval decision history",
    status: "mapped",
    tables: [{ table: "approvals", ageColumn: "createdAt" }],
    notes: "Operator approvals",
    policy: null,
  },
  {
    dataClass: "incident",
    description: "SRE runtime incidents",
    status: "mapped",
    tables: [{ table: "runtime_incidents", ageColumn: "createdAt" }],
    notes: "Runtime incidents",
    policy: null,
  },
  {
    dataClass: "eval",
    description: "Agent evaluation benchmarks",
    status: "mapped",
    tables: [{ table: "eval_runs", ageColumn: "createdAt" }],
    notes: "Benchmark eval runs",
    policy: null,
  },
  {
    dataClass: "conversation",
    description: "Issue thread interactions",
    status: "mapped",
    tables: [{ table: "issue_thread_interactions", ageColumn: "createdAt" }],
    notes: "Thread interactions",
    policy: null,
  },
  {
    dataClass: "memory_raw",
    description: "Agent raw memory operations",
    status: "mapped",
    tables: [{ table: "agent_memory_operations", ageColumn: "createdAt" }],
    notes: "Raw memory operations",
    policy: null,
  },
  {
    dataClass: "memory_summary",
    description: "Summarized memory",
    status: "unmapped",
    tables: [],
    notes: "No existing table cleanly represents this",
    policy: null,
  },
  {
    dataClass: "verified_knowledge",
    description: "Verified company knowledge records",
    status: "mapped",
    tables: [{ table: "verified_knowledge", ageColumn: "createdAt", archivedColumn: "archivedAt" }],
    notes: "Knowledge records supporting archivedAt",
    policy: null,
  },
  {
    dataClass: "backup_metadata",
    description: "Database backup files on disk",
    status: "file_based",
    tables: [],
    notes: "Governed today by BackupRetentionPolicy",
    policy: null,
  },
];

const MOCK_DRY_RUN_AUDIT = {
  result: {
    dataClass: "audit",
    source: "company_audit_logs",
    action: "retain",
    candidateCount: 42,
    oldestCandidate: "2026-06-01T00:00:00.000Z",
    newestCandidate: "2026-07-01T00:00:00.000Z",
    estimatedRows: 42,
    reason: "legal_hold_active",
  },
};

const MOCK_DRY_RUN_MEMORY_SUMMARY = {
  result: {
    dataClass: "memory_summary",
    source: "",
    action: "none",
    candidateCount: 0,
    oldestCandidate: null,
    newestCandidate: null,
    estimatedRows: 0,
    reason: "unsupported_data_class",
  },
};

test.describe("NEXORA F-01 Data Lifecycle Control Center UI", () => {
  test.setTimeout(120_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await newCompany(request, "lifecycle-ui");

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

  test("renders summary cards, 12 data classes table, read-only dry-run dialog, handles empty/error states, survives reload with 0 errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (!text.includes("/api/data-lifecycle") && !text.includes("Failed to load resource")) {
          consoleErrors.push(text);
        }
      }
    });
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // 1. Intercept Data Lifecycle summary & dry-run endpoints
    await page.route("**/api/data-lifecycle/summary**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          classifications: MOCK_CLASSIFICATIONS,
          generatedAt: "2026-10-01T09:00:00.000Z",
        }),
      });
    });

    await page.route("**/api/data-lifecycle/dry-run**", async (route) => {
      const url = route.request().url();
      if (url.includes("dataClass=memory_summary")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_DRY_RUN_MEMORY_SUMMARY),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_DRY_RUN_AUDIT),
        });
      }
    });

    // 2. Navigate to AI Office
    await page.goto(`/${seed.prefix}/ai-office?tab=knowledge`);
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });

    // 3. Verify Control Center Data Lifecycle Lab loaded
    const lifecycleHeader = page.getByText("Control Center — Data Lifecycle & 데이터 수명관리 (F-01)");
    await expect(lifecycleHeader).toBeVisible({ timeout: 15_000 });
    const lifecycleLab = lifecycleHeader.locator("xpath=ancestor::div[contains(@class, 'space-y-4')][1]");

    // 4. Verify Summary Cards
    const summaryCards = lifecycleLab.locator(".grid.grid-cols-2.gap-3.sm\\:grid-cols-5");
    await expect(summaryCards).toBeVisible();
    await expect(summaryCards.getByText("전체 Data Class")).toBeVisible();
    await expect(summaryCards.getByText("정책 설정됨")).toBeVisible();
    await expect(summaryCards.getByText("정책 미설정")).toBeVisible();
    await expect(summaryCards.getByText("Legal Hold (보존 잠금)")).toBeVisible();
    await expect(summaryCards.getByText("미매핑 (Unmapped)")).toBeVisible();

    // Verify Counts
    await expect(summaryCards.getByText("12", { exact: true })).toBeVisible();
    await expect(summaryCards.getByText("2", { exact: true })).toBeVisible();
    await expect(summaryCards.getByText("10", { exact: true })).toBeVisible();
    await expect(summaryCards.getByText("1", { exact: true }).first()).toBeVisible();

    // 5. Verify Table Rows and Classifications
    await expect(lifecycleLab.getByText("Audit Log (감사 로그)").or(lifecycleLab.getByText("감사 로그"))).toBeVisible();
    await expect(lifecycleLab.getByText("매핑됨 (Mapped)").first()).toBeVisible();
    await expect(lifecycleLab.getByText("company_audit_logs")).toBeVisible();
    await expect(lifecycleLab.getByText("활성 (Enabled)")).toBeVisible();
    await expect(lifecycleLab.getByText("보존 유지 (Retain)").first()).toBeVisible();
    await expect(lifecycleLab.getByText("영구 보존").first()).toBeVisible();
    await expect(lifecycleLab.getByText("보존 잠금").first()).toBeVisible();

    // Verify Secret Audit row
    await expect(lifecycleLab.getByText("비밀값 접근 감사")).toBeVisible();
    await expect(lifecycleLab.getByText("secret_audit")).toBeVisible();
    await expect(lifecycleLab.getByText("secret_access_events")).toBeVisible();
    await expect(lifecycleLab.getByText("비활성 (Disabled)")).toBeVisible();
    await expect(lifecycleLab.getByText("삭제 (Delete)")).toBeVisible();
    await expect(lifecycleLab.getByText("30일")).toBeVisible();
    await expect(lifecycleLab.getByText("해제됨")).toBeVisible();

    // Verify Unmapped Memory Summary row
    await expect(lifecycleLab.getByText("요약 메모리")).toBeVisible();
    await expect(lifecycleLab.getByText("미매핑 (Unmapped)").first()).toBeVisible();
    await expect(lifecycleLab.getByText("연결 테이블 없음")).toBeVisible();
    await expect(lifecycleLab.getByText("아직 실제 저장 테이블과 연결되지 않음")).toBeVisible();

    // Verify File-based Backup Metadata row
    await expect(lifecycleLab.getByText("DB 백업 아티팩트")).toBeVisible();
    await expect(lifecycleLab.getByText("파일 기반 (File-based)")).toBeVisible();
    await expect(lifecycleLab.getByText("파일시스템 디렉터리")).toBeVisible();

    // Verify Verified Knowledge row with archivedAt badge
    await expect(lifecycleLab.getByText("검증된 사내 지식")).toBeVisible();
    await expect(lifecycleLab.getByText("archivedAt 지원")).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f01-lifecycle-01-loaded.png`, fullPage: true });

    // 6. Test Dry Run Dialog (Audit)
    const dryRunButtons = lifecycleLab.getByRole("button", { name: "Dry Run 보기" });
    await expect(dryRunButtons.first()).toBeVisible();
    await dryRunButtons.first().click();

    // Verify Dialog content
    const dryRunDialog = page.locator("[role='dialog']");
    await expect(dryRunDialog.getByText("Dry Run 시뮬레이션 결과")).toBeVisible({ timeout: 10_000 });
    await expect(
      dryRunDialog.getByText("⚠️ 읽기 전용 시뮬레이션입니다. 실제 데이터나 백업 파일은 삭제/변경되지 않습니다."),
    ).toBeVisible();
    await expect(dryRunDialog.getByText("42건")).toBeVisible();
    await expect(dryRunDialog.getByText("42행")).toBeVisible();
    await expect(dryRunDialog.getByText("보존 잠금 (Legal Hold Active)")).toBeVisible();
    await expect(dryRunDialog.getByText("code: legal_hold_active")).toBeVisible();
    await expect(
      dryRunDialog.getByText("법적 보존 잠금(Legal Hold)이 활성화되어 있어 모든 정리가 전면 차단됩니다."),
    ).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f01-lifecycle-02-dryrun-dialog.png`, fullPage: true });

    // Close Dialog using '닫기' button
    const closeBtn = dryRunDialog.getByRole("button", { name: "닫기" });
    await closeBtn.click();
    await expect(dryRunDialog).not.toBeVisible({ timeout: 5000 });

    // 7. Test Dry Run Dialog on Unmapped Class (memory_summary)
    const memoryRow = lifecycleLab.locator("tr", { hasText: "memory_summary" });
    await expect(memoryRow).toBeVisible();
    const memoryDryRunBtn = memoryRow.getByRole("button", { name: "Dry Run 보기" });
    await memoryDryRunBtn.click();

    await expect(dryRunDialog).toBeVisible({ timeout: 10_000 });
    await expect(dryRunDialog.getByText("0건")).toBeVisible();
    await expect(dryRunDialog.getByText("0행")).toBeVisible();
    await expect(dryRunDialog.getByText("미매핑 데이터 분류 (Unsupported)")).toBeVisible();
    await expect(dryRunDialog.getByText("code: unsupported_data_class")).toBeVisible();
    await expect(
      dryRunDialog.getByText("해당 데이터 종류는 아직 실제 저장 테이블과 연결되지 않아 자동 수명관리를 지원하지 않습니다."),
    ).toBeVisible();

    // Close Dialog via Escape
    await page.keyboard.press("Escape");
    await expect(dryRunDialog).not.toBeVisible({ timeout: 5000 });

    // 8. Test Empty State Handling (0 policies configured)
    await page.unroute("**/api/data-lifecycle/summary**");
    await page.route("**/api/data-lifecycle/summary**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          classifications: MOCK_CLASSIFICATIONS.map((c) => ({ ...c, policy: null })),
          generatedAt: "2026-10-01T09:00:00.000Z",
        }),
      });
    });

    const refreshBtn = lifecycleLab.getByRole("button", { name: /새로고침/ });
    await refreshBtn.click();

    await expect(page.getByText("아직 활성화된 Data Lifecycle 정책이 없습니다.")).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText("현재는 12개 데이터 분류 및 읽기 전용 Dry Run 기반만 준비된 상태입니다."),
    ).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f01-lifecycle-03-empty-state.png`, fullPage: true });

    // 9. Test API Error State Handling
    await page.unroute("**/api/data-lifecycle/summary**");
    await page.route("**/api/data-lifecycle/summary**", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal Server Error" }),
      });
    });

    await refreshBtn.click();
    await expect(page.getByText("Data Lifecycle 데이터를 불러올 수 없습니다.")).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/f01-lifecycle-04-api-error.png`, fullPage: true });

    // 10. Test Reload Stability
    await page.unroute("**/api/data-lifecycle/summary**");
    await page.route("**/api/data-lifecycle/summary**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          classifications: MOCK_CLASSIFICATIONS,
          generatedAt: "2026-10-01T09:00:00.000Z",
        }),
      });
    });

    await page.reload();
    await expect(main.getByRole("heading", { name: "AI Office" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Control Center — Data Lifecycle & 데이터 수명관리 (F-01)")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Audit Log (감사 로그)").or(page.getByText("감사 로그"))).toBeVisible();

    // 11. Assert 0 uncaught console errors and 0 page errors
    expect(pageErrors, `uncaught page errors: ${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console errors: ${consoleErrors.join("\n")}`).toHaveLength(0);
  });
});
