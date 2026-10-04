import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertOctagon,
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock,
  Database,
  FileCheck2,
  FileWarning,
  HardDrive,
  Info,
  Lock,
  RefreshCw,
  ServerCrash,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatDate, formatDateTime, relativeTime } from "@/lib/utils";
import { describeApiError } from "@/api/client";
import {
  backupApi,
  type DatabaseBackupHealthStatus,
  type DatabaseBackupHealthWarningCode,
} from "@/api/backup";

export const BACKUP_WARNING_DESCRIPTIONS: Record<
  DatabaseBackupHealthWarningCode,
  { label: string; description: string }
> = {
  database_backup_missing: {
    label: "백업 파일 부재 (Missing Backup)",
    description: "유효한 백업 파일(.sql.gz)이 백업 디렉토리에 존재하지 않습니다.",
  },
  database_backup_stale: {
    label: "백업 수명 초과 (Stale Backup)",
    description:
      "최신 백업 생성 시각이 최대 허용 수명(maxAgeHours)을 초과하여 백업이 지연되고 있습니다.",
  },
  database_backup_last_failure: {
    label: "최근 백업 실패 감지 (Last Failure Marker)",
    description: "백업 또는 원격 동기화 실패 마커 파일(db-backup-to-s3.failure)이 감지되었습니다.",
  },
  database_backup_check_failed: {
    label: "백업 헬스체크 검사 실패 (Check Failed)",
    description: "백업 디렉토리 접근 권한 오류, 파일 읽기 오류 또는 상태 검사 예외가 발생했습니다.",
  },
};

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || isNaN(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function BackupStatusBadge({
  enabled,
  status,
}: {
  enabled: boolean;
  status: "ok" | "warning";
}) {
  if (!enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
        <Lock className="h-3 w-3" /> 비활성화 (Disabled)
      </span>
    );
  }
  if (status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="h-3 w-3" /> 정상 (Active)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
      <AlertTriangle className="h-3 w-3" /> 주의/실패 (Warning)
    </span>
  );
}

export function RestoreStatusBadge() {
  return (
    <span
      data-testid="restore-status-badge"
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400"
    >
      <Clock className="h-3 w-3" /> 미제공 / 운영 UAT 미검증 (NO-GO)
    </span>
  );
}

export function FailoverStatusBadge() {
  return (
    <span
      data-testid="failover-status-badge"
      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
    >
      <Lock className="h-3 w-3" /> 미지원 / 향후 로드맵 (Future)
    </span>
  );
}

export function AIOfficeBackupDrLab() {
  const [manualBackupDialogOpen, setManualBackupDialogOpen] = useState(false);
  const [manualBackupFeedback, setManualBackupFeedback] = useState<string | null>(null);

  const backupHealthQuery = useQuery({
    queryKey: ["ai-office-backup-health"],
    queryFn: () => backupApi.getHealth(),
    refetchInterval: 30_000,
  });

  const healthData: DatabaseBackupHealthStatus | undefined = backupHealthQuery.data;

  const handleRefresh = () => {
    backupHealthQuery.refetch();
  };

  const handleManualBackupTriggerClick = () => {
    setManualBackupFeedback(null);
    setManualBackupDialogOpen(true);
  };

  const handleManualBackupConfirmedInSafeMode = () => {
    // REAL_PRODUCTION_POST_ENABLED=NO: Safe mode intercepts and explains the protection.
    setManualBackupFeedback(
      "Phase 1 안전 모드 보호됨: 운영 데이터베이스 백업 POST 호출은 별도 승인 절차를 위해 비활성화되어 있습니다 (REAL_PRODUCTION_POST_ENABLED=NO).",
    );
    setManualBackupDialogOpen(false);
  };

  const latestBackupName = healthData?.latestBackup?.name ?? null;
  const latestBackupAge =
    healthData?.latestBackup?.ageHours != null
      ? `${healthData.latestBackup.ageHours.toFixed(1)}시간 전`
      : null;
  const latestBackupSize = formatBytes(healthData?.latestBackup?.sizeBytes);

  const hasRecoveryArtifact = !!healthData?.latestRecoveryArtifact;
  const hasLastFailure = !!healthData?.lastFailure;
  const warnings = healthData?.warnings ?? [];

  return (
    <div
      data-testid="backup-dr-lab"
      className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground shadow-xs"
    >
      {/* 1. Header */}
      <div className="flex flex-col gap-2 border-b pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <Database className="h-5 w-5 text-primary" />
            Control Center — Backup & Disaster Recovery (F-03)
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            데이터베이스 자동 백업 상태, 복구 아티팩트 보존 현황 및 DR 거버넌스 관제 센터입니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={backupHealthQuery.isFetching}
            data-testid="backup-refresh-btn"
          >
            <RefreshCw
              className={cn("h-4 w-4", backupHealthQuery.isFetching && "animate-spin")}
            />
            새로고침
          </Button>
        </div>
      </div>

      {/* API Error Callout */}
      {backupHealthQuery.isError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          백업 상태 조회 실패:{" "}
          {describeApiError(backupHealthQuery.error, "서버와의 통신에 실패했습니다.")}
        </div>
      ) : null}

      {/* Safe Mode Feedback Alert */}
      {manualBackupFeedback ? (
        <div
          role="status"
          data-testid="manual-backup-feedback-alert"
          className="flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
        >
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 shrink-0" />
            <span>{manualBackupFeedback}</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setManualBackupFeedback(null)}
          >
            닫기
          </Button>
        </div>
      ) : null}

      {/* 2. Top Summary KPI Cards (5 Cards) */}
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
        aria-label="Backup summary metrics"
      >
        {/* KPI 1: Backup System Status */}
        <div className="rounded-lg border bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>백업 시스템 상태</span>
            <HardDrive className="h-4 w-4 text-primary" />
          </div>
          <div className="mt-1.5" data-testid="backup-status-kpi">
            <BackupStatusBadge
              enabled={healthData?.enabled ?? false}
              status={healthData?.status ?? "ok"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {healthData?.enabled ? "주기적 백업 활성화" : "백업 서비스 비활성"}
          </p>
        </div>

        {/* KPI 2: Latest Valid Backup */}
        <div className="rounded-lg border bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>최신 유효 백업</span>
            <FileCheck2 className="h-4 w-4 text-emerald-500" />
          </div>
          <div
            className="mt-1 truncate text-sm font-semibold text-foreground"
            data-testid="latest-backup-kpi"
            title={latestBackupName ?? "백업 없음"}
          >
            {latestBackupName ?? "백업 없음"}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {latestBackupAge ? `${latestBackupAge} (${latestBackupSize})` : "생성 이력 없음"}
          </p>
        </div>

        {/* KPI 3: Recovery Artifact */}
        <div className="rounded-lg border bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>복구 아티팩트 여부</span>
            <FileWarning className="h-4 w-4 text-amber-500" />
          </div>
          <div className="mt-1 text-sm font-semibold" data-testid="recovery-artifact-kpi">
            {hasRecoveryArtifact ? (
              <span className="text-amber-600 dark:text-amber-400">감지됨 (미완료 파일)</span>
            ) : (
              <span className="text-foreground">없음 (정상)</span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hasRecoveryArtifact ? "수동 정리 및 점검 필요" : "중단된 임시 덤프 없음"}
          </p>
        </div>

        {/* KPI 4: Schedule / Max Age */}
        <div className="rounded-lg border bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>스케줄 / 최대 수명</span>
            <Clock className="h-4 w-4 text-primary" />
          </div>
          <div
            className="mt-1 text-sm font-semibold text-foreground"
            data-testid="schedule-maxage-kpi"
          >
            {healthData ? `최대 ${healthData.maxAgeHours}시간` : "기준 로딩 중..."}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">기준 초과 시 stale 경고 발령</p>
        </div>

        {/* KPI 5: DR Governance Status */}
        <div className="rounded-lg border bg-card p-3 shadow-xs">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>DR 거버넌스 상태</span>
            <ShieldCheck className="h-4 w-4 text-primary" />
          </div>
          <div
            className="mt-1 text-sm font-semibold text-foreground"
            data-testid="dr-governance-kpi"
          >
            통제 모드 (Safe Mode)
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">복구: UAT 미검증 | 페일오버: 미지원</p>
        </div>
      </div>

      {/* 3. Backup Health & Warnings Panel */}
      <Card data-testid="backup-health-panel">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-sm font-semibold">
              백업 상태 및 무결성 진단 (Integrity Diagnostics)
            </CardTitle>
            <div className="text-xs text-muted-foreground">
              백업 디렉토리:{" "}
              <code
                className="rounded bg-muted px-1.5 py-0.5 text-foreground"
                data-testid="backup-directory"
              >
                {healthData?.backupDir || "(미설정)"}
              </code>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-xs">
          {/* Recovery Artifact Warning Box (if present) */}
          {hasRecoveryArtifact && healthData?.latestRecoveryArtifact ? (
            <div
              data-testid="recovery-artifact-alert"
              className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-200"
            >
              <div className="flex items-start gap-2">
                <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="space-y-1">
                  <div className="font-semibold">
                    미완료 복구 아티팩트 감지: {healthData.latestRecoveryArtifact.name}
                  </div>
                  <p className="text-muted-foreground">
                    이 아티팩트는 백업 실행 시 gzip 압축 단계가 실패하거나 타임아웃되어 남겨진 원본
                    .sql 파일입니다. 유효한 백업의 대체물이 아니며, 디스크 공간 확보를 위한 수동
                    점검이 필요합니다.
                  </p>
                  <div className="flex flex-wrap gap-3 pt-1 text-muted-foreground">
                    <span>
                      크기: {formatBytes(healthData.latestRecoveryArtifact.sizeBytes)}
                    </span>
                    <span>
                      경과 시간: {healthData.latestRecoveryArtifact.ageHours.toFixed(1)}시간 전
                    </span>
                    <span>사유: {healthData.latestRecoveryArtifact.reason}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Last Failure Alert Box (if present) */}
          {hasLastFailure && healthData?.lastFailure ? (
            <div
              data-testid="backup-last-failure-alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive"
            >
              <div className="flex items-start gap-2">
                <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-1">
                  <div className="font-semibold">최근 백업 실패 기록 (Last Failure Marker)</div>
                  <p>{healthData.lastFailure.message}</p>
                  <div className="text-muted-foreground">
                    기록 시각: {formatDateTime(healthData.lastFailure.mtime)} (경로:{" "}
                    {healthData.lastFailure.path})
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Active Warnings List */}
          <div className="space-y-2">
            <div className="font-medium text-foreground">활성 무결성 경고 (Active Warnings)</div>
            {warnings.length === 0 ? (
              <div
                data-testid="backup-warnings-empty"
                className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3 text-emerald-700 dark:text-emerald-300"
              >
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                <span>
                  활성 경고 없음 — 모든 검증을 통과했습니다 (최소 크기 4KB 및 gzip 헤더 매직 바이트
                  정상).
                </span>
              </div>
            ) : (
              <div data-testid="backup-warnings-list" className="space-y-2">
                {warnings.map((w, idx) => {
                  const desc = BACKUP_WARNING_DESCRIPTIONS[w.code] ?? {
                    label: w.code,
                    description: w.message,
                  };
                  return (
                    <div
                      key={`${w.code}-${idx}`}
                      className="flex items-start justify-between rounded-md border border-amber-500/20 bg-amber-500/10 p-3"
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                        <div>
                          <span className="font-semibold text-foreground">{desc.label}</span>
                          <p className="mt-0.5 text-muted-foreground">
                            {w.message || desc.description}
                          </p>
                        </div>
                      </div>
                      <Badge variant="outline" className="border-amber-500/30 text-amber-600 dark:text-amber-400">
                        {w.code}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 4. Manual Backup Action Card (Safe Mode Gated) */}
      <Card data-testid="manual-backup-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">
            수동 백업 트리거 (Manual Backup Trigger)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          <p className="text-muted-foreground">
            정기 일정 외에 필요 시 인스턴스 전체 데이터베이스의 즉시 덤프 생성을 요청할 수 있습니다.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              <span>
                안전 모드 적용 중: 운영 DB 부하 방지를 위해 현재 화면에서는 승인 확인 다이얼로그만
                제공됩니다.
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleManualBackupTriggerClick}
              data-testid="manual-backup-trigger-btn"
            >
              <Archive className="mr-1.5 h-4 w-4 text-primary" />
              수동 백업 생성
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 5. Honest Status: Restore Section (NO BUTTONS) */}
      <Card data-testid="restore-status-panel">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-sm font-semibold">
              데이터베이스 복구 (Database Restore)
            </CardTitle>
            <RestoreStatusBadge />
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            내부 패키지(<code className="rounded bg-muted px-1 text-foreground">@paperclipai/db</code>)에{" "}
            <code className="rounded bg-muted px-1 text-foreground">runDatabaseRestore</code> 함수 및 격리
            합성 단위 테스트는 구현·검증되어 있으나, 운영 환경 UAT(User Acceptance Testing)가
            완료되지 않아(NO-GO 상태) 공개 복구 HTTP API가 의도적으로 배포되지 않았습니다.
          </p>
          <div className="rounded-md border border-border bg-muted/50 p-2.5">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Terminal className="h-3.5 w-3.5" />
              운영 가이드라인
            </div>
            <p className="mt-1 text-muted-foreground">
              운영 데이터 복구는 시스템 무결성을 위해 반드시 통제된 재해 복구(DR) 프로토콜에 따라
              인스턴스 관리자가 CLI 및 안전한 샌드박스 환경에서 수동 절차로만 수행해야 합니다.
            </p>
            <div className="mt-2 text-xs text-muted-foreground">
              관련 추적: <code className="rounded bg-muted px-1 text-foreground">F03_REAL_BACKUP_SANDBOX_RESTORE_UAT</code>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 6. Honest Status: Failover / HA Section (NO BUTTONS) */}
      <Card data-testid="failover-status-panel">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-sm font-semibold">
              고가용성 및 장애 조치 (Failover / High Availability)
            </CardTitle>
            <FailoverStatusBadge />
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            현재 Paperclip은 단일 인스턴스 아키텍처로 운영 중이며, 실시간 복제(Replication) 및
            자동 장애 조치(Automatic Failover)는 지원되지 않습니다.
          </p>
          <div className="rounded-md border border-border bg-muted/50 p-2.5">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <ServerCrash className="h-3.5 w-3.5" />
              향후 아키텍처 로드맵
            </div>
            <p className="mt-1 text-muted-foreground">
              추후 다중 가용 영역(Multi-AZ), 읽기 전용 복제본(Read Replica) 연동 및 무중단
              전환 로드맵(<code className="rounded bg-muted px-1 text-foreground">F03_FAILOVER_HA_FUTURE</code>)에서 순차적으로 설계 및 제공될 예정입니다.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 7. Manual Backup Confirmation Dialog (Safe Mode) */}
      <Dialog open={manualBackupDialogOpen} onOpenChange={setManualBackupDialogOpen}>
        <DialogContent data-testid="manual-backup-dialog">
          <DialogHeader>
            <DialogTitle>수동 데이터베이스 백업 확인</DialogTitle>
            <DialogDescription>
              인스턴스 전체 데이터베이스의 덤프 파일 생성을 요청하시겠습니까?
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 text-xs">
            <div
              data-testid="manual-backup-safe-mode-notice"
              className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-200"
            >
              <div className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="space-y-1">
                  <div className="font-semibold">[Phase 1 안전 모드 적용 중]</div>
                  <p>
                    운영 데이터베이스 백업 트리거(
                    <code className="rounded bg-muted px-1 text-foreground">
                      POST /api/instance/database-backups
                    </code>
                    )는 시스템 I/O 및 백엔드 락 방지를 위해 별도 승인 절차를 통해 보호됩니다.
                  </p>
                  <p className="font-medium text-amber-700 dark:text-amber-300">
                    현재 화면에서는 실제 운영 API 호출이 차단되어 있습니다 (REAL_PRODUCTION_POST_ENABLED=NO).
                  </p>
                </div>
              </div>
            </div>

            <p className="text-muted-foreground">
              확인을 누르면 안전 모드 보호 메시지가 표시되며 실제 백업 작업은 실행되지 않습니다.
            </p>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setManualBackupDialogOpen(false)}
              data-testid="manual-backup-cancel-btn"
            >
              취소
            </Button>
            <Button
              size="sm"
              onClick={handleManualBackupConfirmedInSafeMode}
              data-testid="manual-backup-confirm-btn"
            >
              확인 (안전 모드 보호됨)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
