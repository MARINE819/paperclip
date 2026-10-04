// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIOfficeBackupDrLab } from "./AIOfficeBackupDrLab";
import type { DatabaseBackupHealthStatus } from "../api/backup";

const mockBackupApi = vi.hoisted(() => ({
  getHealth: vi.fn(),
  runManualBackup: vi.fn(),
}));

vi.mock("@/api/backup", () => ({
  backupApi: mockBackupApi,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HEALTHY_BACKUP_STATUS: DatabaseBackupHealthStatus = {
  enabled: true,
  status: "ok",
  backupDir: "C:\\Users\\Nexora\\paperclip\\data\\backups",
  maxAgeHours: 26,
  latestBackup: {
    name: "paperclip-backup-2026-10-01T12-00-00.sql.gz",
    path: "C:\\Users\\Nexora\\paperclip\\data\\backups\\paperclip-backup-2026-10-01T12-00-00.sql.gz",
    mtime: "2026-10-01T12:00:00.000Z",
    ageHours: 2.4,
    sizeBytes: 15728640,
  },
  latestRecoveryArtifact: null,
  lastFailure: null,
  warnings: [],
};

const STALE_BACKUP_STATUS: DatabaseBackupHealthStatus = {
  enabled: true,
  status: "warning",
  backupDir: "C:\\Users\\Nexora\\paperclip\\data\\backups",
  maxAgeHours: 26,
  latestBackup: {
    name: "paperclip-backup-2026-09-28T00-00-00.sql.gz",
    path: "C:\\Users\\Nexora\\paperclip\\data\\backups\\paperclip-backup-2026-09-28T00-00-00.sql.gz",
    mtime: "2026-09-28T00:00:00.000Z",
    ageHours: 72.0,
    sizeBytes: 15000000,
  },
  latestRecoveryArtifact: null,
  lastFailure: null,
  warnings: [
    {
      code: "database_backup_stale",
      message: "Latest database backup is stale.",
    },
  ],
};

const FAILED_AND_RECOVERY_STATUS: DatabaseBackupHealthStatus = {
  enabled: true,
  status: "warning",
  backupDir: "C:\\Users\\Nexora\\paperclip\\data\\backups",
  maxAgeHours: 26,
  latestBackup: {
    name: "paperclip-backup-2026-09-30T12-00-00.sql.gz",
    path: "C:\\Users\\Nexora\\paperclip\\data\\backups\\paperclip-backup-2026-09-30T12-00-00.sql.gz",
    mtime: "2026-09-30T12:00:00.000Z",
    ageHours: 20.0,
    sizeBytes: 14000000,
  },
  latestRecoveryArtifact: {
    name: "paperclip-backup-interrupted.sql",
    path: "C:\\Users\\Nexora\\paperclip\\data\\backups\\paperclip-backup-interrupted.sql",
    mtime: "2026-10-01T14:00:00.000Z",
    ageHours: 0.8,
    sizeBytes: 45000000,
    reason: "gzip compression timeout after uncompressed dump",
  },
  lastFailure: {
    path: "C:\\Users\\Nexora\\paperclip\\data\\health\\db-backup-to-s3.failure",
    mtime: "2026-10-01T14:05:00.000Z",
    message: "Network connection refused during S3 multipart upload",
  },
  warnings: [
    {
      code: "database_backup_last_failure",
      message: "Database backup failure marker is present.",
    },
  ],
};

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 20));
}

describe("AIOfficeBackupDrLab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let render: () => Promise<void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    root = createRoot(container);
    vi.clearAllMocks();

    render = async () => {
      flushSync(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <AIOfficeBackupDrLab />
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        await settle();
      });
    };
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    document.body.style.pointerEvents = "";
    vi.clearAllMocks();
  });

  it("renders healthy backup state with all 5 KPI cards and clean diagnostics", async () => {
    mockBackupApi.getHealth.mockResolvedValue(HEALTHY_BACKUP_STATUS);

    await render();

    expect(mockBackupApi.getHealth).toHaveBeenCalled();

    // Verify main lab container
    const lab = container.querySelector("[data-testid='backup-dr-lab']");
    expect(lab).not.toBeNull();
    expect(lab?.textContent).toContain("Control Center — Backup & Disaster Recovery (F-03)");

    // Verify 5 KPI summary cards
    const statusKpi = container.querySelector("[data-testid='backup-status-kpi']");
    expect(statusKpi?.textContent).toContain("정상 (Active)");

    const latestBackupKpi = container.querySelector("[data-testid='latest-backup-kpi']");
    expect(latestBackupKpi?.textContent).toContain("paperclip-backup-2026-10-01T12-00-00.sql.gz");

    const recoveryArtifactKpi = container.querySelector("[data-testid='recovery-artifact-kpi']");
    expect(recoveryArtifactKpi?.textContent).toContain("없음 (정상)");

    const scheduleMaxAgeKpi = container.querySelector("[data-testid='schedule-maxage-kpi']");
    expect(scheduleMaxAgeKpi?.textContent).toContain("최대 26시간");

    const drGovernanceKpi = container.querySelector("[data-testid='dr-governance-kpi']");
    expect(drGovernanceKpi?.textContent).toContain("통제 모드 (Safe Mode)");

    // Verify Diagnostics Panel & Empty Warnings
    const emptyWarnings = container.querySelector("[data-testid='backup-warnings-empty']");
    expect(emptyWarnings).not.toBeNull();
    expect(emptyWarnings?.textContent).toContain("활성 경고 없음");

    // Verify absence of failure & recovery alerts
    expect(container.querySelector("[data-testid='recovery-artifact-alert']")).toBeNull();
    expect(container.querySelector("[data-testid='backup-last-failure-alert']")).toBeNull();

    // Verify Restore panel: honest text ONLY, NO action buttons
    const restorePanel = container.querySelector("[data-testid='restore-status-panel']");
    expect(restorePanel).not.toBeNull();
    expect(restorePanel?.textContent).toContain("미제공 / 운영 UAT 미검증 (NO-GO)");
    expect(restorePanel?.querySelectorAll("button").length).toBe(0);

    // Verify Failover panel: honest text ONLY, NO action buttons
    const failoverPanel = container.querySelector("[data-testid='failover-status-panel']");
    expect(failoverPanel).not.toBeNull();
    expect(failoverPanel?.textContent).toContain("미지원 / 향후 로드맵 (Future)");
    expect(failoverPanel?.querySelectorAll("button").length).toBe(0);
  });

  it("renders stale backup warnings correctly", async () => {
    mockBackupApi.getHealth.mockResolvedValue(STALE_BACKUP_STATUS);

    await render();

    const statusKpi = container.querySelector("[data-testid='backup-status-kpi']");
    expect(statusKpi?.textContent).toContain("주의/실패 (Warning)");

    const warningsList = container.querySelector("[data-testid='backup-warnings-list']");
    expect(warningsList).not.toBeNull();
    expect(warningsList?.textContent).toContain("백업 수명 초과 (Stale Backup)");
    expect(warningsList?.textContent).toContain("database_backup_stale");
  });

  it("renders recovery artifact alert and last failure details", async () => {
    mockBackupApi.getHealth.mockResolvedValue(FAILED_AND_RECOVERY_STATUS);

    await render();

    // KPI shows recovery artifact detected
    const recoveryArtifactKpi = container.querySelector("[data-testid='recovery-artifact-kpi']");
    expect(recoveryArtifactKpi?.textContent).toContain("감지됨 (미완료 파일)");

    // Recovery artifact alert is rendered
    const recoveryAlert = container.querySelector("[data-testid='recovery-artifact-alert']");
    expect(recoveryAlert).not.toBeNull();
    expect(recoveryAlert?.textContent).toContain("paperclip-backup-interrupted.sql");
    expect(recoveryAlert?.textContent).toContain("gzip compression timeout");

    // Last failure alert is rendered
    const failureAlert = container.querySelector("[data-testid='backup-last-failure-alert']");
    expect(failureAlert).not.toBeNull();
    expect(failureAlert?.textContent).toContain("Network connection refused during S3 multipart upload");
  });

  it("opens manual backup confirmation dialog and enforces safe mode without calling production POST", async () => {
    mockBackupApi.getHealth.mockResolvedValue(HEALTHY_BACKUP_STATUS);

    await render();

    // Trigger button exists
    const triggerBtn = container.querySelector("[data-testid='manual-backup-trigger-btn']") as HTMLButtonElement;
    expect(triggerBtn).not.toBeNull();

    // Click trigger button
    await act(async () => {
      triggerBtn.click();
      await settle();
    });

    // Dialog opens in document.body
    const dialog = document.body.querySelector("[data-testid='manual-backup-dialog']");
    expect(dialog).not.toBeNull();

    // Safe mode notice is present
    const notice = document.body.querySelector("[data-testid='manual-backup-safe-mode-notice']");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("REAL_PRODUCTION_POST_ENABLED=NO");
    expect(notice?.textContent).toContain("POST /api/instance/database-backups");

    // Click confirm button
    const confirmBtn = document.body.querySelector("[data-testid='manual-backup-confirm-btn']") as HTMLButtonElement;
    expect(confirmBtn).not.toBeNull();
    await act(async () => {
      confirmBtn.click();
      await settle();
    });

    // Verify production POST API was NOT called
    expect(mockBackupApi.runManualBackup).not.toHaveBeenCalled();

    // Verify feedback alert in container
    const feedbackAlert = container.querySelector("[data-testid='manual-backup-feedback-alert']");
    expect(feedbackAlert).not.toBeNull();
    expect(feedbackAlert?.textContent).toContain("Phase 1 안전 모드 보호됨");
  });

  it("renders disabled state when backup service is not enabled", async () => {
    mockBackupApi.getHealth.mockResolvedValue({
      enabled: false,
      status: "ok",
      backupDir: "",
      maxAgeHours: 24,
      latestBackup: null,
      latestRecoveryArtifact: null,
      lastFailure: null,
      warnings: [],
    });

    await render();

    const statusKpi = container.querySelector("[data-testid='backup-status-kpi']");
    expect(statusKpi?.textContent).toContain("비활성화 (Disabled)");

    const latestBackupKpi = container.querySelector("[data-testid='latest-backup-kpi']");
    expect(latestBackupKpi?.textContent).toContain("백업 없음");
  });
});
