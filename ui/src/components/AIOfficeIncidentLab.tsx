import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertOctagon,
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  History,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import { describeApiError } from "@/api/client";
import {
  incidentsApi,
  type IncidentSeverity,
  type IncidentStatus,
  type RootCauseStatus,
  type RuntimeIncidentSummary,
} from "@/api/incidents";

/** Human-readable detector definitions for F-06 runtime incidents */
export const DETECTOR_DESCRIPTIONS: Record<string, { label: string; description: string }> = {
  windows_control_c_exit_detected: {
    label: "Windows 0xC000013A (Control-C) 프로세스 비정상 종료",
    description: "Windows 콘솔 핸들러에서 0xC000013A STATUS_CONTROL_C_EXIT로 프로세스가 강제 종료된 이벤트입니다.",
  },
  runtime_duplicate_detected: {
    label: "중복 런타임 프로세스 감지 (포트/PID 경합)",
    description: "동일한 인스턴스에 둘 이상의 Supervisor 또는 서버 프로세스가 실행 중인 상태입니다.",
  },
  supervisor_recovery_failed: {
    label: "Supervisor 자가 복구 한도 초과 (복구 실패)",
    description: "Supervisor가 정해진 복구 재시도 횟수를 모두 소진하고 대기 주기로 전환되었습니다.",
  },
  runtime_restart_loop: {
    label: "런타임 재시작 루프 감지 (15분 내 3회 이상)",
    description: "단시간 내에 런타임 시작 요청이 연속으로 발생하여 크래시 루프에 빠진 상태입니다.",
  },
  runtime_connectivity_mismatch: {
    label: "포트 및 API/DB 연결 상태 불일치",
    description: "포트는 열려 있으나 API/DB 헬스체크가 응답하지 않거나, 반대로 포트가 닫힌 연결 불일치 상태입니다.",
  },
  runtime_pid_mismatch: {
    label: "PID 파일 및 실제 프로세스 불일치",
    description: "기록된 PID 파일의 프로세스가 실제 실행 중인 프로세스와 다르거나 응답하지 않는 상태입니다.",
  },
};

export function IncidentSeverityBadge({ severity }: { severity: IncidentSeverity }) {
  const styles: Record<IncidentSeverity, { label: string; className: string; icon: typeof AlertTriangle }> = {
    critical: {
      label: "Critical (치명)",
      className: "border-destructive/40 bg-destructive/15 text-destructive",
      icon: AlertOctagon,
    },
    high: {
      label: "High (높음)",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
      icon: AlertTriangle,
    },
    medium: {
      label: "Medium (중간)",
      className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      icon: AlertTriangle,
    },
    low: {
      label: "Low (낮음)",
      className: "border-border bg-muted text-muted-foreground",
      icon: Info,
    },
  };

  const current = styles[severity] ?? {
    label: severity,
    className: "border-border bg-muted text-muted-foreground",
    icon: Info,
  };
  const Icon = current.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        current.className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {current.label}
    </span>
  );
}

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  const styles: Record<IncidentStatus, { label: string; className: string; icon: typeof AlertTriangle }> = {
    open: {
      label: "열림 (Open)",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
      icon: AlertTriangle,
    },
    recovering: {
      label: "복구 중 (Recovering)",
      className: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
      icon: RotateCcw,
    },
    resolved: {
      label: "해결됨 (Resolved)",
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      icon: CheckCircle2,
    },
  };

  const current = styles[status] ?? {
    label: status,
    className: "border-border bg-muted text-muted-foreground",
    icon: Info,
  };
  const Icon = current.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        current.className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {current.label}
    </span>
  );
}

export function RootCauseStatusBadge({ status }: { status: RootCauseStatus }) {
  const styles: Record<RootCauseStatus, { label: string; className: string }> = {
    known: {
      label: "원인 규명됨",
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    },
    investigating: {
      label: "조사 중",
      className: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    },
    unknown: {
      label: "원인 미확인 (UNKNOWN)",
      className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
  };

  const current = styles[status] ?? {
    label: status,
    className: "border-border bg-muted text-muted-foreground",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        current.className,
      )}
    >
      {current.label}
    </span>
  );
}

export function AIOfficeIncidentLab() {
  const [selectedIncident, setSelectedIncident] = useState<RuntimeIncidentSummary | null>(null);
  const [showResolved, setShowResolved] = useState<boolean>(false);

  const incidentsQuery = useQuery({
    queryKey: ["instance", "incidents"],
    queryFn: () => incidentsApi.list(),
    refetchInterval: 30_000,
  });

  const openIncidents = useMemo(
    () => incidentsQuery.data?.open ?? [],
    [incidentsQuery.data],
  );

  const resolvedIncidents = useMemo(
    () => incidentsQuery.data?.resolved ?? [],
    [incidentsQuery.data],
  );

  const activeRecoveringCount = useMemo(
    () => openIncidents.filter((i) => i.status === "recovering").length,
    [openIncidents],
  );

  const activeOpenCount = useMemo(
    () => openIncidents.filter((i) => i.status === "open").length,
    [openIncidents],
  );

  const criticalOrHighCount = useMemo(
    () =>
      openIncidents.filter(
        (i) => i.severity === "critical" || i.severity === "high",
      ).length,
    [openIncidents],
  );

  const failureMemoryCandidateCount = useMemo(
    () =>
      [...openIncidents, ...resolvedIncidents].filter(
        (i) => i.failureMemoryCandidate,
      ).length,
    [openIncidents, resolvedIncidents],
  );

  const isLoading = incidentsQuery.isLoading;
  const isError = incidentsQuery.isError;
  const errorMessage = incidentsQuery.error
    ? describeApiError(incidentsQuery.error, "Incident API 응답 실패")
    : null;

  return (
    <Card className="space-y-4 p-4">
      {/* 1. Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b pb-3">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold tracking-tight">
              Control Center — Incident & SRE Center (F-06)
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Supervisor 자가 복구, 프로세스/포트 불일치, 런타임 크래시 및 Failure Memory 후보를 실시간 관측합니다. (모든 상태는 백엔드 SRE 스캐너 보고 기준)
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => incidentsQuery.refetch()}
          disabled={isLoading}
          className="h-8 gap-1.5 self-start sm:self-auto"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      {/* API Error state */}
      {isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive">
          <div className="font-semibold">Incident 데이터를 불러올 수 없습니다.</div>
          <p className="mt-1 text-muted-foreground">
            {errorMessage ?? "서버 연결을 확인하거나 나중에 다시 시도해 주세요."}
          </p>
        </div>
      ) : null}

      {/* 2. Incident Summary Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">활성 장애 (Open)</div>
          <div
            className={cn(
              "mt-1 text-lg font-semibold",
              activeOpenCount > 0 ? "text-destructive" : "text-foreground",
            )}
          >
            {isLoading ? "…" : activeOpenCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">복구 진행 중</div>
          <div
            className={cn(
              "mt-1 text-lg font-semibold",
              activeRecoveringCount > 0
                ? "text-blue-600 dark:text-blue-400"
                : "text-foreground",
            )}
          >
            {isLoading ? "…" : activeRecoveringCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">해결된 장애 (Resolved)</div>
          <div className="mt-1 text-lg font-semibold text-emerald-600 dark:text-emerald-400">
            {isLoading ? "…" : resolvedIncidents.length}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">Critical / High</div>
          <div
            className={cn(
              "mt-1 text-lg font-semibold",
              criticalOrHighCount > 0 ? "text-destructive" : "text-foreground",
            )}
          >
            {isLoading ? "…" : criticalOrHighCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">Failure Memory 후보</div>
          <div className="mt-1 text-lg font-semibold text-amber-600 dark:text-amber-400">
            {isLoading ? "…" : failureMemoryCandidateCount}
          </div>
        </Card>
      </div>

      {/* 3. Active Incidents Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <AlertOctagon className="h-4 w-4 text-destructive" />
            <span>Active Incidents (현재 활성 장애 — {openIncidents.length}건)</span>
          </div>
        </div>

        {openIncidents.length === 0 ? (
          /* Empty state */
          <div className="flex items-center gap-3 rounded-lg border border-dashed p-4 text-xs text-muted-foreground bg-muted/5">
            <ShieldCheck className="h-5 w-5 text-emerald-500 shrink-0" />
            <div>
              <div className="font-semibold text-foreground">현재 열린 Incident 없음</div>
              <p className="mt-0.5 text-muted-foreground">
                모든 시스템 런타임 및 Supervisor가 정상 가동 중이며 감지된 장애가 없습니다.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {openIncidents.map((inc) => {
              const meta = DETECTOR_DESCRIPTIONS[inc.code];
              return (
                <div
                  key={inc.id}
                  onClick={() => setSelectedIncident(inc)}
                  className="cursor-pointer rounded-lg border p-3 hover:bg-muted/10 transition-colors"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs">
                          {meta?.label ?? inc.code}
                        </span>
                        <IncidentSeverityBadge severity={inc.severity} />
                        <IncidentStatusBadge status={inc.status} />
                        {inc.failureMemoryCandidate ? (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                            <Brain className="h-3 w-3 shrink-0" />
                            Failure Memory 후보
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {meta?.description ?? `Detector: ${inc.code}`}
                      </p>
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-xs px-2 self-start sm:self-auto shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedIncident(inc);
                      }}
                    >
                      상세 보기
                    </Button>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground border-t pt-2">
                    <div>
                      최초 감지:{" "}
                      <span className="text-foreground">
                        {relativeTime(inc.detectedAt)}
                      </span>
                    </div>
                    <div>
                      최근 관측:{" "}
                      <span className="text-foreground">
                        {relativeTime(inc.lastObservedAt)}
                      </span>
                    </div>
                    <div>
                      반복 횟수:{" "}
                      <span className="font-semibold text-foreground">
                        {inc.occurrenceCount}회
                      </span>
                    </div>
                    <div>
                      영향 컴포넌트:{" "}
                      <span className="text-foreground">
                        {inc.affectedComponents.join(", ") || "—"}
                      </span>
                    </div>
                    <div>
                      복구 상태:{" "}
                      <span className="text-foreground">
                        {inc.recoveryAttempted
                          ? `시도됨 (${inc.recoveryResult ?? "대기/진행 중"})`
                          : "미시도"}
                      </span>
                    </div>
                    <div>
                      원인 상태:{" "}
                      <RootCauseStatusBadge status={inc.rootCauseStatus} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 4. Known / Historical Incidents Section */}
      <div className="space-y-2 border-t pt-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <History className="h-4 w-4" />
            <span>과거 해결된 Incident 내역 ({resolvedIncidents.length}건)</span>
          </div>
          {resolvedIncidents.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowResolved(!showResolved)}
              className="h-6 text-xs gap-1"
            >
              {showResolved ? (
                <>
                  접기 <ChevronUp className="h-3 w-3" />
                </>
              ) : (
                <>
                  내역 보기 ({resolvedIncidents.length}) <ChevronDown className="h-3 w-3" />
                </>
              )}
            </Button>
          ) : null}
        </div>

        {resolvedIncidents.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            과거 해결된 Incident 내역이 없습니다.
          </div>
        ) : showResolved ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="border-b bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">장애 코드 / 내용</th>
                  <th className="px-3 py-2 text-left font-medium">심각도</th>
                  <th className="px-3 py-2 text-left font-medium">상태</th>
                  <th className="px-3 py-2 text-right font-medium">반복 횟수</th>
                  <th className="px-3 py-2 text-left font-medium">복구 결과</th>
                  <th className="px-3 py-2 text-left font-medium">해결 일시</th>
                  <th className="px-3 py-2 text-left font-medium">Failure Memory</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {resolvedIncidents.map((inc) => {
                  const meta = DETECTOR_DESCRIPTIONS[inc.code];
                  return (
                    <tr
                      key={inc.id}
                      className="hover:bg-muted/10 cursor-pointer"
                      onClick={() => setSelectedIncident(inc)}
                    >
                      <td className="px-3 py-2 font-medium">
                        {meta?.label ?? inc.code}
                      </td>
                      <td className="px-3 py-2">
                        <IncidentSeverityBadge severity={inc.severity} />
                      </td>
                      <td className="px-3 py-2">
                        <IncidentStatusBadge status={inc.status} />
                      </td>
                      <td className="px-3 py-2 text-right font-semibold">
                        {inc.occurrenceCount}회
                      </td>
                      <td className="px-3 py-2">
                        {inc.recoveryResult ?? (inc.recoveryAttempted ? "시도됨" : "—")}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {inc.resolvedAt ? relativeTime(inc.resolvedAt) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {inc.failureMemoryCandidate ? (
                          <span className="text-amber-600 dark:text-amber-400 font-medium">
                            후보 등록
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* 5. Incident Detail Modal Dialog */}
      <Dialog
        open={selectedIncident !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedIncident(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-primary" />
              <span>Incident 상세 정보</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              SRE 런타임 스캐너가 감지하고 추적한 장애 상세 정보입니다.
            </DialogDescription>
          </DialogHeader>

          {selectedIncident ? (
            <div className="space-y-3 text-xs">
              {/* 장애 식별 */}
              <div className="rounded-md border p-3 space-y-2 bg-muted/10">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground">
                    {DETECTOR_DESCRIPTIONS[selectedIncident.code]?.label ?? selectedIncident.code}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <IncidentSeverityBadge severity={selectedIncident.severity} />
                    <IncidentStatusBadge status={selectedIncident.status} />
                  </div>
                </div>
                <p className="text-muted-foreground">
                  {DETECTOR_DESCRIPTIONS[selectedIncident.code]?.description ?? "런타임 모니터링 신호에 의해 감지된 이상 상태입니다."}
                </p>
                <div className="text-muted-foreground pt-1 border-t">
                  Incident ID: <span className="font-mono text-foreground">{selectedIncident.id}</span>
                </div>
                {selectedIncident.fingerprint ? (
                  <div className="text-muted-foreground">
                    Fingerprint: <span className="font-mono text-foreground">{selectedIncident.fingerprint}</span>
                  </div>
                ) : null}
              </div>

              {/* 타임라인 및 관측 */}
              <div className="rounded-md border p-3 space-y-2">
                <div className="font-semibold text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  타임라인 및 관측 빈도
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">최초 감지: </span>
                    <span className="font-medium text-foreground">
                      {formatDate(selectedIncident.detectedAt)} ({relativeTime(selectedIncident.detectedAt)})
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">최근 관측: </span>
                    <span className="font-medium text-foreground">
                      {formatDate(selectedIncident.lastObservedAt)} ({relativeTime(selectedIncident.lastObservedAt)})
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">해결 일시: </span>
                    <span className="font-medium text-foreground">
                      {selectedIncident.resolvedAt
                        ? `${formatDate(selectedIncident.resolvedAt)} (${relativeTime(selectedIncident.resolvedAt)})`
                        : "미해결 (진행 중)"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">누적 관측 횟수: </span>
                    <span className="font-semibold text-foreground">
                      {selectedIncident.occurrenceCount}회 반복
                    </span>
                  </div>
                </div>
                <div className="text-muted-foreground pt-1 border-t">
                  영향 컴포넌트:{" "}
                  <span className="font-medium text-foreground">
                    {selectedIncident.affectedComponents.join(", ") || "—"}
                  </span>
                </div>
              </div>

              {/* 자가 복구 상태 */}
              <div className="rounded-md border p-3 space-y-2">
                <div className="font-semibold text-muted-foreground flex items-center gap-1">
                  <Wrench className="h-3.5 w-3.5" />
                  Supervisor 자가 복구 추적
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">복구 시도 여부: </span>
                    <span className="font-medium text-foreground">
                      {selectedIncident.recoveryAttempted ? "시도됨" : "미시도"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">복구 결과: </span>
                    <span className="font-medium text-foreground">
                      {selectedIncident.recoveryResult ?? "대기/진행 중"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">원인 분석 상태: </span>
                    <RootCauseStatusBadge status={selectedIncident.rootCauseStatus} />
                  </div>
                </div>
              </div>

              {/* Failure Memory 후보 상태 */}
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="font-semibold text-muted-foreground flex items-center gap-1">
                  <Brain className="h-3.5 w-3.5 text-amber-500" />
                  Failure Memory 후보 검토
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">후보 등록 상태</span>
                  {selectedIncident.failureMemoryCandidate ? (
                    <span className="font-semibold text-amber-600 dark:text-amber-400">
                      후보 등록됨 (CEO / 엔지니어링 사후 검토 대상)
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      후보 미지정 (단발성 또는 증거 불충분)
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  F-06 규칙: 실제 증거가 확보되고, 복구가 시도되었거나 다회 독립 관측된 경우에만 Failure Memory 후보로 지정됩니다. (자동 승격 금지 원칙)
                </p>
              </div>

              {/* 증거 데이터 (Evidence) */}
              <div className="rounded-md border p-3 space-y-1.5">
                <div className="font-semibold text-muted-foreground">증거 데이터 (Evidence)</div>
                {selectedIncident.evidence && selectedIncident.evidence.length > 0 ? (
                  <pre className="max-h-36 overflow-auto rounded bg-muted/40 p-2 text-xs font-mono">
                    {JSON.stringify(selectedIncident.evidence, null, 2)}
                  </pre>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    상세 원시 로그/증거는 스캐너 요약 응답에 생략되었거나 초기 이벤트 상태입니다.
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
