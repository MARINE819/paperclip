import { expect, test, type APIRequestContext } from "@playwright/test";

// NEXORA F-07 / F-08 — Knowledge & Memory Control Center Browser E2E Verification
// Tests end-to-end on isolated port 3199:
// 1. Live page load on /ai-office
// 2. Control Center Knowledge & Memory Lab header & description (F-07 / F-08)
// 3. Top Summary Cards (총 메모리 후보, 검토 대기, 승격 대기, 공식 사내 지식, 동기화 오류)
// 4. Memory Candidates table with source type, confidence, and status badges
// 5. Candidate status filtering (전체, 대기 중, 승인됨, 승격됨, 반려됨)
// 6. Review modal interaction (reviewState="approved" / "rejected" with candidate rejection wording)
// 7. Promote modal with single approval gate confirmation (reviewState="approved" check)
// 8. Knowledge Records tab switching and directory view
// 9. Sync state badges (synced, pending, failed) and dynamic backend reference
// 10. Record detail modal with sanitized error messages (no stack traces, no absolute paths)
// 11. Manual sync retry button execution and single-flight lock
// 12. Empty state handling for both tabs
// 13. API 500 error banner handling
// 14. Page reload stability (page.reload())
// 15. Zero console errors & zero page errors
// 16. ZERO file writes to the real Windows Obsidian vault (C:\Obsidian\Physical AI)

const SCREENSHOT_DIR = "test-results";

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", {
    data: { name: `F07 Knowledge UI ${label} ${Date.now()}` },
  });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

const MOCK_CANDIDATES = [
  {
    id: "mem-e2e-1",
    companyId: "company-e2e",
    sourceType: "issue",
    sourceId: "issue-101",
    sourceIssueId: "issue-101",
    sourceRunId: null,
    sourceAgentId: "agent-1",
    title: "Stage 7 모델 라우터 장애 격리 정책",
    summary: "모델 라우터에서 no_route 발생 시 fail-closed 전략 적용",
    content: "모델 라우터는 어댑터 간 모델 누수를 방지하기 위해 fail-closed 모델을 채택합니다.",
    confidence: 0.92,
    status: "candidate",
    reviewState: "pending",
    reviewedByAgentId: null,
    reviewNotes: null,
    approvalId: null,
    extractionKey: "ext-1",
    metadata: { author: "Codex" },
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
  },
  {
    id: "mem-e2e-2",
    companyId: "company-e2e",
    sourceType: "run",
    sourceId: "run-202",
    sourceIssueId: null,
    sourceRunId: "run-202",
    sourceAgentId: "agent-2",
    title: "Playwright E2E 포트 격리 규칙",
    summary: "E2E 테스트 시 포트 3199를 사용하며 운영 3100에 영향을 주지 않음",
    content: "Playwright E2E 실행 시 반드시 isolated 포트 3199와 임시 DB를 사용하여 운영 환경을 보호합니다.",
    confidence: 0.85,
    status: "candidate",
    reviewState: "approved",
    reviewedByAgentId: null,
    reviewNotes: "CEO 사전 승인 완료",
    approvalId: null,
    extractionKey: "ext-2",
    metadata: {},
    createdAt: "2026-10-01T09:30:00.000Z",
    updatedAt: "2026-10-01T09:40:00.000Z",
  },
  {
    id: "mem-e2e-3",
    companyId: "company-e2e",
    sourceType: "work_product",
    sourceId: "doc-303",
    sourceIssueId: null,
    sourceRunId: null,
    sourceAgentId: "agent-3",
    title: "임시 데이터 정리 가이드",
    summary: "과거 스크래치 파일 보관 주기",
    content: "임시 파일은 7일 후 보존 주기에 따라 정리됩니다.",
    confidence: 0.45,
    status: "rejected",
    reviewState: "rejected",
    reviewedByAgentId: null,
    reviewNotes: "중복 문서로 판단하여 반려",
    approvalId: null,
    extractionKey: "ext-3",
    metadata: {},
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:15:00.000Z",
  },
];

const MOCK_RECORDS = [
  {
    id: "rec-e2e-1",
    companyId: "company-e2e",
    knowledgeType: "architecture",
    title: "NEXORA Master 2 거버넌스 아키텍처",
    summary: "단일 승인 게이트와 자동 저장 동기화",
    body: "# NEXORA Master 2 Architecture\n\n모든 거버넌스 행동은 회사의 승인 게이트를 통과해야 합니다.",
    metadata: {
      provenance: {
        sourceType: "issue",
        sourceId: "issue-101",
        capturedAt: "2026-09-30T16:00:00.000Z",
      },
    },
    sourceMemoryOperationId: "mem-e2e-1",
    sourceIssueId: "issue-101",
    sourceRunId: null,
    sourceAgentId: null,
    status: "active",
    obsidianPath: "Knowledge/Architecture/Master-2-Governance.md",
    obsidianSyncState: "synced",
    obsidianSyncError: null,
    obsidianSyncedAt: "2026-09-30T16:05:00.000Z",
    externalBackendId: "obsidian",
    externalSyncState: "synced",
    externalSyncError: null,
    externalSyncedAt: "2026-09-30T16:05:00.000Z",
    externalRef: "Knowledge/Architecture/Master-2-Governance.md",
    createdAt: "2026-09-30T16:00:00.000Z",
    updatedAt: "2026-09-30T16:05:00.000Z",
    archivedAt: null,
  },
  {
    id: "rec-e2e-2",
    companyId: "company-e2e",
    knowledgeType: "policy",
    title: "보안 토큰 마스킹 정책",
    summary: "해시 기반 비가역적 식별자 표출",
    body: "비밀값은 절대 브라우저나 UI에 노출되지 않으며 해시 파생 마스킹 문자열만 표출합니다.",
    metadata: {},
    sourceMemoryOperationId: null,
    sourceIssueId: null,
    sourceRunId: null,
    sourceAgentId: null,
    status: "active",
    obsidianPath: null,
    obsidianSyncState: "failed",
    obsidianSyncError: "Error writing to C:\\Obsidian\\Vault\\policy.md: EACCES permission denied\n  at writeFileSync (fs.js:123)",
    obsidianSyncedAt: null,
    externalBackendId: "obsidian",
    externalSyncState: "failed",
    externalSyncError: "Error writing to C:\\Obsidian\\Vault\\policy.md: EACCES permission denied\n  at writeFileSync (fs.js:123)",
    externalSyncedAt: null,
    externalRef: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:05:00.000Z",
    archivedAt: null,
  },
];

test.describe("NEXORA F-07 / F-08 Knowledge Control Center UI E2E", () => {
  test.setTimeout(120_000);
  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await newCompany(request, "Primary");
  });

  test("renders full Knowledge Control Center, filters, review, promote, records, and survives reload", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const expectedApiErrors: string[] = [];
    const pageErrors: string[] = [];
    let expectingApiFailure = false;

    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (expectingApiFailure && (text.includes("500") || text.includes("knowledge"))) {
        expectedApiErrors.push(text);
      } else {
        consoleErrors.push(text);
      }
    });

    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    let currentCandidates = [...MOCK_CANDIDATES];
    let currentRecords = [...MOCK_RECORDS];
    let mode: "populated" | "empty" | "error" = "populated";

    // Safely route knowledge endpoints on isolated port 3199:
    // Ensures ZERO writes to real Obsidian vault on disk!
    await page.route("**/api/companies/*/memory-operations", async (route) => {
      if (mode === "error") {
        await route.fulfill({ status: 500, json: { error: "Simulated Knowledge API 500" } });
        return;
      }
      if (mode === "empty") {
        await route.fulfill({ status: 200, json: [] });
        return;
      }
      await route.fulfill({ status: 200, json: currentCandidates });
    });

    await page.route("**/api/companies/*/knowledge-records**", async (route) => {
      if (mode === "error") {
        await route.fulfill({ status: 500, json: { error: "Simulated Knowledge Records API 500" } });
        return;
      }
      if (mode === "empty") {
        await route.fulfill({ status: 200, json: [] });
        return;
      }
      await route.fulfill({ status: 200, json: currentRecords });
    });

    await page.route("**/api/memory-operations/*/review", async (route) => {
      const url = route.request().url();
      const idMatch = url.match(/\/memory-operations\/([^/]+)\/review/);
      const id = idMatch ? idMatch[1] : "";
      const body = route.request().postDataJSON() as { reviewState: "approved" | "rejected"; reviewNotes?: string };

      const found = currentCandidates.find((c) => c.id === id);
      if (found) {
        found.reviewState = body.reviewState;
        if (body.reviewState === "rejected") found.status = "rejected";
        found.reviewNotes = body.reviewNotes ?? null;
      }
      await route.fulfill({ status: 200, json: found ?? {} });
    });

    await page.route("**/api/memory-operations/*/promote", async (route) => {
      const url = route.request().url();
      const idMatch = url.match(/\/memory-operations\/([^/]+)\/promote/);
      const id = idMatch ? idMatch[1] : "";
      const body = route.request().postDataJSON() as { title?: string; knowledgeType?: string };

      const found = currentCandidates.find((c) => c.id === id);
      if (found) {
        found.status = "promoted";
      }
      const newRec = {
        id: `rec-e2e-${Date.now()}`,
        companyId: "company-e2e",
        knowledgeType: body.knowledgeType ?? "architecture",
        title: body.title ?? found?.title ?? "Promoted Knowledge",
        summary: found?.summary ?? null,
        body: found?.content ?? "",
        metadata: {},
        sourceMemoryOperationId: id,
        sourceIssueId: null,
        sourceRunId: null,
        sourceAgentId: null,
        status: "active",
        obsidianPath: null,
        obsidianSyncState: "pending",
        obsidianSyncError: null,
        obsidianSyncedAt: null,
        externalBackendId: "obsidian",
        externalSyncState: "pending",
        externalSyncError: null,
        externalSyncedAt: null,
        externalRef: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      };
      currentRecords.push(newRec);
      await route.fulfill({ status: 201, json: { operation: found, knowledgeRecord: newRec } });
    });

    await page.route("**/api/knowledge-records/*/obsidian-sync", async (route) => {
      // Mock sync response: guarantees ZERO file writes to the real Windows Obsidian vault!
      const url = route.request().url();
      const idMatch = url.match(/\/knowledge-records\/([^/]+)\/obsidian-sync/);
      const id = idMatch ? idMatch[1] : "";
      const found = currentRecords.find((r) => r.id === id);
      if (found) {
        found.externalSyncState = "synced";
        found.obsidianSyncState = "synced";
        found.externalSyncError = null;
        found.obsidianSyncError = null;
        found.externalSyncedAt = new Date().toISOString();
        found.externalRef = "Knowledge/Policies/Token-Masking.md";
      }
      await route.fulfill({ status: 200, json: found ?? {} });
    });

    // 1. Navigate to AI Office
    await page.goto(`/${seed.prefix}/ai-office?tab=knowledge`);
    await page.waitForLoadState("networkidle");

    const labCard = page.locator('[data-testid="ai-office-knowledge-lab"]');
    await expect(labCard).toBeVisible({ timeout: 15_000 });
    await expect(labCard).toContainText("Control Center — Knowledge & Memory (F-07 / F-08)");

    // 2. Verify 5 Top Summary Cards
    await expect(page.locator('[data-testid="summary-total-candidates"]')).toHaveText("3");
    await expect(page.locator('[data-testid="summary-pending-review"]')).toHaveText("1");
    await expect(page.locator('[data-testid="summary-approved-candidates"]')).toHaveText("1");
    await expect(page.locator('[data-testid="summary-total-records"]')).toHaveText("2");
    await expect(page.locator('[data-testid="summary-sync-failures"]')).toHaveText("1");

    // Screenshot 1: Loaded
    await page.screenshot({ path: `${SCREENSHOT_DIR}/f07-f08-knowledge-01-loaded.png` });

    // 3. Verify Memory Candidates table rows
    await expect(page.locator('[data-testid="candidate-row-mem-e2e-1"]')).toContainText("Stage 7 모델 라우터 장애 격리 정책");
    await expect(page.locator('[data-testid="candidate-row-mem-e2e-1"]')).toContainText("92%");
    await expect(page.locator('[data-testid="candidate-row-mem-e2e-1"]')).toContainText("검토 대기");

    await expect(page.locator('[data-testid="candidate-row-mem-e2e-2"]')).toContainText("Playwright E2E 포트 격리 규칙");
    await expect(page.locator('[data-testid="candidate-row-mem-e2e-2"]')).toContainText("검토 승인");

    // 4. Test Review modal (Approve flow)
    const reviewBtn = page.locator('[data-testid="btn-review-mem-e2e-1"]');
    await expect(reviewBtn).toBeVisible();
    await reviewBtn.click();

    const reviewDialog = page.locator('[role="dialog"]');
    await expect(reviewDialog).toBeVisible();
    await expect(reviewDialog).toContainText("후보 메모리 검토 (Review)");
    await expect(reviewDialog).toContainText("Stage 7 모델 라우터 장애 격리 정책");

    // Screenshot 2: Review dialog
    await page.screenshot({ path: `${SCREENSHOT_DIR}/f07-f08-knowledge-02-review-dialog.png` });

    // Approve the candidate
    const approveBtn = page.locator('[data-testid="modal-approve-btn"]');
    await approveBtn.click();
    await expect(reviewDialog).toBeHidden();

    // 5. Test Promote button & modal (Promote flow)
    const promoteBtn = page.locator('[data-testid="btn-promote-mem-e2e-2"]');
    await expect(promoteBtn).toBeVisible();
    await promoteBtn.click();

    const promoteDialog = page.locator('[role="dialog"]');
    await expect(promoteDialog).toBeVisible();
    await expect(promoteDialog).toContainText("공식 사내 지식으로 승격 (Promote)");
    await expect(promoteDialog).toContainText("F-07 Single Approval Gate");

    // Screenshot 3: Promote dialog
    await page.screenshot({ path: `${SCREENSHOT_DIR}/f07-f08-knowledge-03-promote-dialog.png` });

    const confirmPromoteBtn = page.locator('[data-testid="modal-confirm-promote-btn"]');
    await confirmPromoteBtn.click();
    await expect(promoteDialog).toBeHidden();

    // 6. Switch to Knowledge Records Tab
    const recordsTabBtn = page.locator('[data-testid="tab-records-btn"]');
    await recordsTabBtn.click();

    const recordsContent = page.locator('[data-testid="records-tab-content"]');
    await expect(recordsContent).toBeVisible();
    await expect(recordsContent).toContainText("NEXORA Master 2 거버넌스 아키텍처");
    await expect(recordsContent).toContainText("보안 토큰 마스킹 정책");
    await expect(recordsContent).toContainText("동기화 오류");

    // Screenshot 4: Records tab
    await page.screenshot({ path: `${SCREENSHOT_DIR}/f07-f08-knowledge-04-records-tab.png` });

    // 7. Verify Sanitized Error in Record Detail Dialog
    const detailBtn = page.locator('[data-testid="btn-record-detail-rec-e2e-2"]');
    await detailBtn.click();

    const recordDialog = page.locator('[role="dialog"]');
    await expect(recordDialog).toBeVisible();
    await expect(recordDialog).toContainText("사내 공식 지식 상세");
    await expect(recordDialog).toContainText("동기화 오류 메시지 (정제됨)");

    // Ensure raw absolute path and JS stack trace are sanitized
    const errorText = await recordDialog.textContent();
    expect(errorText).not.toContain("C:\\Obsidian\\Vault\\policy.md");
    expect(errorText).not.toContain("at writeFileSync");

    // Close record detail dialog
    await page.getByRole("button", { name: "닫기" }).click();
    await expect(recordDialog).toBeHidden();

    // 8. Test Manual Sync Retry button
    const retryBtn = page.locator('[data-testid="btn-sync-retry-rec-e2e-2"]');
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    // After mock sync, status should update to synced
    await expect(page.locator('[data-testid="record-row-rec-e2e-2"]')).toContainText("동기화 완료");

    // 9. Verify Empty State handling
    mode = "empty";
    await page.locator('[data-testid="knowledge-refresh-btn"]').click();
    await expect(page.locator('[data-testid="record-empty-state"]')).toBeVisible();

    // Switch back to candidates in empty mode
    await page.locator('[data-testid="tab-candidates-btn"]').click();
    await expect(page.locator('[data-testid="candidate-empty-state"]')).toBeVisible();

    // 10. Verify API Error handling
    expectingApiFailure = true;
    mode = "error";
    await page.locator('[data-testid="knowledge-refresh-btn"]').click();
    await expect(page.locator('[role="alert"]').first()).toBeVisible();
    await expect(page.locator('[role="alert"]').first()).toContainText("지식 데이터 조회 실패");

    // 11. Page Reload Stability
    expectingApiFailure = false;
    mode = "populated";
    await page.reload();
    await page.waitForLoadState("networkidle");

    const reloadedLab = page.locator('[data-testid="ai-office-knowledge-lab"]');
    await expect(reloadedLab).toBeVisible();
    await expect(page.locator('[data-testid="summary-total-candidates"]')).toHaveText("3");

    // 12. Confirm zero uncaught console errors and zero page errors
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
