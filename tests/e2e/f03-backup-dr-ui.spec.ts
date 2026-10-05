import { expect, test, type APIRequestContext } from "@playwright/test";

// NEXORA F-03 — Backup / DR Control Center Browser E2E verification
// Tests end-to-end on isolated port 3199:
// 1. Live page load on /ai-office?tab=sre
// 2. Control Center Backup & DR Lab header & description (F-03)
// 3. Top 5 KPI Summary Cards (백업 상태, 최신 유효 백업, 복구 아티팩트 여부, 스케줄/최대 수명, DR 거버넌스)
// 4. Backup Health & Integrity Diagnostics Panel (디렉토리, 경고 목록)
// 5. Manual Backup trigger button & Safe Mode confirmation dialog
// 6. Verification that REAL_PRODUCTION_POST_ENABLED=NO: NO POST call made to /api/instance/database-backups
// 7. Restore Section: Honest status badge "미제공 / 운영 UAT 미검증 (NO-GO)" and ZERO action buttons
// 8. Failover Section: Honest status badge "미지원 / 향후 로드맵 (Future)" and ZERO action buttons
// 9. Stale backup, last failure marker, and recovery artifact (.sql) scenario testing via health mock
// 10. IA Tab switching and lazy mounting (SRE -> Quality -> All)
// 11. Page reload stability (page.reload())
// 12. Zero console errors & zero page errors

type Seed = { companyId: string; prefix: string };

async function newCompany(request: APIRequestContext, label: string): Promise<Seed> {
  const res = await request.post("/api/companies", {
    data: { name: `F03 Backup DR UI ${label} ${Date.now()}` },
  });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

const MOCK_DIAGNOSTICS_HEALTH = {
  status: "ok",
  version: "1.0.0",
  deploymentMode: "local_trusted",
  databaseBackup: {
    enabled: true,
    status: "warning",
    backupDir: "C:\\Users\\Nexora\\paperclip\\data\\backups",
    maxAgeHours: 26,
    latestBackup: {
      name: "paperclip-backup-2026-09-28T00-00-00.sql.gz",
      path: "C:\\Users\\Nexora\\paperclip\\data\\backups\\paperclip-backup-2026-09-28T00-00-00.sql.gz",
      mtime: "2026-09-28T00:00:00.000Z",
      ageHours: 96.5,
      sizeBytes: 15728640,
    },
    latestRecoveryArtifact: {
      name: "paperclip-backup-unfinished.sql",
      path: "C:\\Users\\Nexora\\paperclip\\data\\backups\\paperclip-backup-unfinished.sql",
      mtime: "2026-10-01T15:00:00.000Z",
      ageHours: 1.2,
      sizeBytes: 52428800,
      reason: "gzip compression timeout after uncompressed dump",
    },
    lastFailure: {
      path: "C:\\Users\\Nexora\\paperclip\\data\\health\\db-backup-to-s3.failure",
      mtime: "2026-10-01T15:05:00.000Z",
      message: "Connection refused during S3 backup sync",
    },
    warnings: [
      {
        code: "database_backup_stale",
        message: "Latest database backup is stale.",
      },
      {
        code: "database_backup_last_failure",
        message: "Database backup failure marker is present.",
      },
    ],
  },
};

test.describe("NEXORA F-03 Backup & DR Control Center UI", () => {
  test.setTimeout(120_000);

  let seed: Seed;

  test.beforeAll(async ({ request }) => {
    seed = await newCompany(request, "backup-dr-ui");

    const agentRes = await request.post(`/api/companies/${seed.companyId}/agents`, {
      data: {
        name: "JARVIS",
        role: "ceo",
        title: "CTO / Orchestrator",
        adapterType: "claude_local",
      },
    });
    expect(agentRes.ok(), `create agent failed: ${await agentRes.text()}`).toBe(true);
  });

  test("loads live /ai-office, mounts F-03 in SRE tab with 5 KPI cards, honest badges, and zero restore/failover buttons", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(`/${seed.prefix}/ai-office?tab=sre`);
    await page.waitForLoadState("networkidle");

    // 1. Verify Header & Description
    const lab = page.locator('[data-testid="backup-dr-lab"]');
    await expect(lab).toBeVisible();
    await expect(lab).toContainText("Control Center — Backup & Disaster Recovery (F-03)");
    await expect(lab).toContainText("데이터베이스 자동 백업 상태, 복구 아티팩트 보존 현황 및 DR 거버넌스 관제 센터입니다.");

    // 2. Verify 5 KPI Summary Cards
    await expect(page.locator('[data-testid="backup-status-kpi"]')).toBeVisible();
    await expect(page.locator('[data-testid="latest-backup-kpi"]')).toBeVisible();
    await expect(page.locator('[data-testid="recovery-artifact-kpi"]')).toBeVisible();
    await expect(page.locator('[data-testid="schedule-maxage-kpi"]')).toBeVisible();
    await expect(page.locator('[data-testid="dr-governance-kpi"]')).toBeVisible();
    await expect(page.locator('[data-testid="dr-governance-kpi"]')).toContainText("통제 모드 (Safe Mode)");

    // 3. Verify Diagnostics Panel
    const diagnosticsPanel = page.locator('[data-testid="backup-health-panel"]');
    await expect(diagnosticsPanel).toBeVisible();
    await expect(diagnosticsPanel).toContainText("백업 디렉토리");

    // 4. Verify Honest Restore Status & ZERO ACTION BUTTONS
    const restorePanel = page.locator('[data-testid="restore-status-panel"]');
    await expect(restorePanel).toBeVisible();
    await expect(page.locator('[data-testid="restore-status-badge"]')).toContainText("미제공 / 운영 UAT 미검증 (NO-GO)");
    await expect(restorePanel).toContainText("runDatabaseRestore");
    await expect(restorePanel).toContainText("F03_REAL_BACKUP_SANDBOX_RESTORE_UAT");
    // Crucial safety invariant: No action button inside restore panel
    expect(await restorePanel.locator("button").count()).toBe(0);

    // 5. Verify Honest Failover Status & ZERO ACTION BUTTONS
    const failoverPanel = page.locator('[data-testid="failover-status-panel"]');
    await expect(failoverPanel).toBeVisible();
    await expect(page.locator('[data-testid="failover-status-badge"]')).toContainText("미지원 / 향후 로드맵 (Future)");
    await expect(failoverPanel).toContainText("F03_FAILOVER_HA_FUTURE");
    // Crucial safety invariant: No action button inside failover panel
    expect(await failoverPanel.locator("button").count()).toBe(0);

    // 6. Zero unexpected console errors
    expect(consoleErrors.filter((e) => !e.includes("favicon"))).toEqual([]);
  });

  test("manual backup triggers Safe Mode confirmation dialog and makes ZERO production POST mutations", async ({
    page,
  }) => {
    let interceptedPostCalls = 0;

    await page.route("**/api/instance/database-backups", async (route) => {
      interceptedPostCalls++;
      await route.abort();
    });

    await page.goto(`/${seed.prefix}/ai-office?tab=sre`);
    await page.waitForLoadState("networkidle");

    // Click Manual Backup Trigger button
    const triggerBtn = page.locator('[data-testid="manual-backup-trigger-btn"]');
    await expect(triggerBtn).toBeVisible();
    await triggerBtn.click();

    // Dialog opens
    const dialog = page.locator('[data-testid="manual-backup-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("수동 데이터베이스 백업 확인");

    // Verify Safe Mode notice
    const safeModeNotice = page.locator('[data-testid="manual-backup-safe-mode-notice"]');
    await expect(safeModeNotice).toBeVisible();
    await expect(safeModeNotice).toContainText("REAL_PRODUCTION_POST_ENABLED=NO");
    await expect(safeModeNotice).toContainText("POST /api/instance/database-backups");

    // Click Confirm button
    const confirmBtn = page.locator('[data-testid="manual-backup-confirm-btn"]');
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // Dialog closes
    await expect(dialog).not.toBeVisible();

    // Feedback alert appears
    const feedbackAlert = page.locator('[data-testid="manual-backup-feedback-alert"]');
    await expect(feedbackAlert).toBeVisible();
    await expect(feedbackAlert).toContainText("Phase 1 안전 모드 보호됨");

    // CRITICAL: ZERO calls were made to POST /api/instance/database-backups
    expect(interceptedPostCalls).toBe(0);
  });

  test("renders diagnostics for stale backup, recovery artifact (.sql), and last failure marker", async ({
    page,
  }) => {
    // Intercept health check to return warning and artifact state
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_DIAGNOSTICS_HEALTH),
      });
    });

    await page.goto(`/${seed.prefix}/ai-office?tab=sre`);
    await page.waitForLoadState("networkidle");

    // 1. KPI warns about recovery artifact
    const recoveryKpi = page.locator('[data-testid="recovery-artifact-kpi"]');
    await expect(recoveryKpi).toContainText("감지됨 (미완료 파일)");

    // 2. Recovery artifact alert is displayed
    const recoveryAlert = page.locator('[data-testid="recovery-artifact-alert"]');
    await expect(recoveryAlert).toBeVisible();
    await expect(recoveryAlert).toContainText("paperclip-backup-unfinished.sql");
    await expect(recoveryAlert).toContainText("gzip 압축 단계가 실패하거나 타임아웃되어 남겨진 원본 .sql 파일");

    // 3. Last failure alert is displayed
    const failureAlert = page.locator('[data-testid="backup-last-failure-alert"]');
    await expect(failureAlert).toBeVisible();
    await expect(failureAlert).toContainText("Connection refused during S3 backup sync");

    // 4. Stale backup warning in warnings list
    const warningsList = page.locator('[data-testid="backup-warnings-list"]');
    await expect(warningsList).toBeVisible();
    await expect(warningsList).toContainText("백업 수명 초과 (Stale Backup)");
    await expect(warningsList).toContainText("database_backup_stale");
  });

  test("IA tab switching correctly isolates and mounts F-03 under SRE and All tabs only", async ({
    page,
  }) => {
    await page.goto(`/${seed.prefix}/ai-office`);
    await page.waitForLoadState("networkidle");

    // Default tab is SRE: F-03 Backup Lab is mounted
    await expect(page.locator('[data-testid="backup-dr-lab"]')).toBeVisible();

    // Switch to Quality tab: F-03 Backup Lab is unmounted
    await page.locator('[data-testid="control-center-tab-quality"]').click();
    await expect(page.locator('[data-testid="control-center-panel-quality"]')).toBeVisible();
    await expect(page.locator('[data-testid="backup-dr-lab"]')).not.toBeVisible();

    // Switch to Knowledge tab: F-03 Backup Lab is unmounted
    await page.locator('[data-testid="control-center-tab-knowledge"]').click();
    await expect(page.locator('[data-testid="control-center-panel-knowledge"]')).toBeVisible();
    await expect(page.locator('[data-testid="backup-dr-lab"]')).not.toBeVisible();

    // Switch to All tab: F-03 Backup Lab is mounted
    await page.locator('[data-testid="control-center-tab-all"]').click();
    await expect(page.locator('[data-testid="backup-dr-lab"]')).toBeVisible();

    // Switch back to SRE tab: F-03 Backup Lab is visible
    await page.locator('[data-testid="control-center-tab-sre"]').click();
    await expect(page.locator('[data-testid="backup-dr-lab"]')).toBeVisible();

    // Page reload stability
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-testid="backup-dr-lab"]')).toBeVisible();
  });
});
