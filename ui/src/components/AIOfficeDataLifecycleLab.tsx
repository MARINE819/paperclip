import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  CheckCircle2,
  Clock,
  Database,
  FileBox,
  FileQuestion,
  FolderSync,
  HelpCircle,
  Info,
  Lock,
  Play,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
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
  dataLifecycleApi,
  type DataLifecycleClass,
  type DataLifecycleClassificationSummary,
  type DataLifecyclePolicy,
  type DataLifecycleRetentionMode,
  type DataLifecycleStatus,
  type DryRunReason,
  type DryRunResult,
} from "@/api/data-lifecycle";

/** Metadata and display information for the 12 data lifecycle classes */
export const DATA_CLASS_META: Record<
  DataLifecycleClass,
  { label: string; koreanName: string; category: string; descriptionFallback: string }
> = {
  audit: {
    label: "audit",
    koreanName: "감사 로그",
    category: "거버넌스/감사",
    descriptionFallback: "일반 회사 활동 및 감사 추적 로그 (Activity Log)",
  },
  runtime: {
    label: "runtime",
    koreanName: "런타임 하트비트 실행 기록",
    category: "실행/운영",
    descriptionFallback: "에이전트 하트비트 실행 이력 및 런타임 결과 (Heartbeat Runs)",
  },
  task: {
    label: "task",
    koreanName: "업무 / 이슈",
    category: "태스크",
    descriptionFallback: "프로젝트 작업 항목 및 태스크 (Issues)",
  },
  approval: {
    label: "approval",
    koreanName: "승인 결정 내역",
    category: "거버넌스",
    descriptionFallback: "운영자 및 휴먼 승인 의사결정 기록 (Approvals)",
  },
  incident: {
    label: "incident",
    koreanName: "SRE 런타임 장애",
    category: "안정성/SRE",
    descriptionFallback: "F-06 런타임 프로세스 크래시 및 Supervisor 장애 내역 (Runtime Incidents)",
  },
  eval: {
    label: "eval",
    koreanName: "Agent 품질 평가",
    category: "품질/시뮬레이션",
    descriptionFallback: "F-04 벤치마크 평가 및 시뮬레이션 실행 기록 (Eval Runs)",
  },
  conversation: {
    label: "conversation",
    koreanName: "이슈 대화 / 상호작용",
    category: "협업",
    descriptionFallback: "이슈 스레드 대화 및 메시지 상호작용 기록 (Thread Interactions)",
  },
  memory_raw: {
    label: "memory_raw",
    koreanName: "에이전트 원본 메모리",
    category: "메모리",
    descriptionFallback: "에이전트 원본 단기/작업 기억 후보 (Memory Operations)",
  },
  memory_summary: {
    label: "memory_summary",
    koreanName: "요약 메모리",
    category: "메모리",
    descriptionFallback: "정제된 요약 메모리 (현재 미매핑 상태)",
  },
  verified_knowledge: {
    label: "verified_knowledge",
    koreanName: "검증된 사내 지식",
    category: "지식",
    descriptionFallback: "승인 및 축적된 공식 사내 지식 베이스 (Knowledge Records, archivedAt 지원)",
  },
  secret_audit: {
    label: "secret_audit",
    koreanName: "비밀값 접근 감사",
    category: "보안",
    descriptionFallback: "F-02 보안 비밀값 조회 및 접근 증적 (Secret Access Events)",
  },
  backup_metadata: {
    label: "backup_metadata",
    koreanName: "DB 백업 아티팩트",
    category: "인프라",
    descriptionFallback: "디스크 파일시스템 상의 데이터베이스 압축 백업 파일 (/data/backups)",
  },
};

/** User-friendly explanations for dry-run fail-closed reasons */
export const DRY_RUN_REASON_DESCRIPTIONS: Record<
  DryRunReason,
  { label: string; description: string; badgeVariant: "neutral" | "warning" | "success" }
> = {
  no_policy_configured: {
    label: "정책 미설정 (Fail-closed)",
    description: "아직 보존 정책이 설정되지 않았습니다. 안전을 위해 정리 후보 대상이 0건으로 유지됩니다.",
    badgeVariant: "neutral",
  },
  policy_disabled: {
    label: "정책 비활성화 (Disabled)",
    description: "보존 정책이 비활성화(Disabled) 상태입니다. 활성화 전까지 정리 대상에서 제외됩니다.",
    badgeVariant: "neutral",
  },
  legal_hold_active: {
    label: "보존 잠금 (Legal Hold Active)",
    description: "법적 보존 잠금(Legal Hold)이 활성화되어 있어 모든 정리가 전면 차단됩니다.",
    badgeVariant: "warning",
  },
  retention_mode_retain: {
    label: "영구 보존 (Retain)",
    description: "보존 모드가 '영구 보존(Retain)'으로 설정되어 있어 정리 후보가 발생하지 않습니다.",
    badgeVariant: "neutral",
  },
  invalid_retention_days: {
    label: "보존 일수 설정 이상 (Invalid Days)",
    description: "보존 일수 설정이 유효하지 않거나 백업 디렉터리를 확인할 수 없어 계산이 차단되었습니다.",
    badgeVariant: "warning",
  },
  unsupported_data_class: {
    label: "미매핑 데이터 분류 (Unsupported)",
    description: "해당 데이터 종류는 아직 실제 저장 테이블과 연결되지 않아 자동 수명관리를 지원하지 않습니다.",
    badgeVariant: "neutral",
  },
  ok: {
    label: "시뮬레이션 완료 (OK)",
    description: "설정된 보존 정책 기준에 따라 정상적으로 시뮬레이션 후보 건수가 계산되었습니다.",
    badgeVariant: "success",
  },
};

export function ClassificationStatusBadge({ status }: { status: DataLifecycleStatus }) {
  switch (status) {
    case "mapped":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
          <Database className="h-3 w-3" />
          매핑됨 (Mapped)
        </span>
      );
    case "unmapped":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
          <FileQuestion className="h-3 w-3" />
          미매핑 (Unmapped)
        </span>
      );
    case "file_based":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-purple-500/10 px-1.5 py-0.5 text-xs font-medium text-purple-600 dark:text-purple-400">
          <FileBox className="h-3 w-3" />
          파일 기반 (File-based)
        </span>
      );
  }
}

export function RetentionModeBadge({ mode }: { mode: DataLifecycleRetentionMode }) {
  switch (mode) {
    case "retain":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
          <ShieldCheck className="h-3 w-3" />
          보존 유지 (Retain)
        </span>
      );
    case "archive":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          <Archive className="h-3 w-3" />
          아카이브 (Archive)
        </span>
      );
    case "delete":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-400">
          <XCircle className="h-3 w-3" />
          삭제 (Delete)
        </span>
      );
    case "archive_then_delete":
      return (
        <span className="inline-flex items-center gap-1 rounded bg-indigo-500/10 px-1.5 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400">
          <FolderSync className="h-3 w-3" />
          아카이브 후 삭제 (Archive → Delete)
        </span>
      );
  }
}

export function AIOfficeDataLifecycleLab() {
  const [selectedDryRunClass, setSelectedDryRunClass] = useState<DataLifecycleClass | null>(null);

  // 1. Fetch Classifications & Policies Summary
  const summaryQuery = useQuery({
    queryKey: ["data-lifecycle", "summary"],
    queryFn: () => dataLifecycleApi.summary(),
    refetchInterval: 60_000,
  });

  const classifications = useMemo(
    () => summaryQuery.data?.classifications ?? [],
    [summaryQuery.data],
  );

  // 2. Fetch Dry-Run when a specific class is selected
  const dryRunQuery = useQuery({
    queryKey: ["data-lifecycle", "dry-run", selectedDryRunClass],
    queryFn: () => (selectedDryRunClass ? dataLifecycleApi.dryRun(selectedDryRunClass) : null),
    enabled: selectedDryRunClass !== null,
    retry: false,
  });

  // Calculate summary stats
  const totalClassesCount = classifications.length;
  const configuredPolicyCount = useMemo(
    () => classifications.filter((c) => c.policy !== null).length,
    [classifications],
  );
  const unconfiguredPolicyCount = useMemo(
    () => classifications.filter((c) => c.policy === null).length,
    [classifications],
  );
  const legalHoldCount = useMemo(
    () => classifications.filter((c) => Boolean(c.policy?.legalHold)).length,
    [classifications],
  );
  const unmappedCount = useMemo(
    () => classifications.filter((c) => c.status === "unmapped").length,
    [classifications],
  );

  const isLoading = summaryQuery.isLoading;
  const isError = summaryQuery.isError;
  const errorMessage = summaryQuery.error
    ? describeApiError(summaryQuery.error, "Data Lifecycle API 응답 실패")
    : null;

  return (
    <Card className="space-y-4 p-4">
      {/* 1. Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold tracking-tight">
              Control Center — Data Lifecycle & 데이터 수명관리 (F-01)
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            데이터 보존 주기, 아카이브/삭제 후보 시뮬레이션(Dry Run) 및 법적 보존(Legal Hold) 상태를 실시간 관제합니다. (읽기 전용 시뮬레이션 — 실제 데이터는 변경되지 않습니다)
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => summaryQuery.refetch()}
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
          <div className="font-semibold">Data Lifecycle 데이터를 불러올 수 없습니다.</div>
          <p className="mt-1 text-muted-foreground">
            {errorMessage ?? "서버 연결을 확인하거나 나중에 다시 시도해 주세요."}
          </p>
        </div>
      ) : null}

      {/* 2. Top Summary Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">전체 Data Class</div>
          <div className="mt-1 text-lg font-semibold text-foreground">
            {isLoading ? "…" : totalClassesCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">정책 설정됨</div>
          <div className="mt-1 text-lg font-semibold text-blue-600 dark:text-blue-400">
            {isLoading ? "…" : configuredPolicyCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">정책 미설정</div>
          <div className="mt-1 text-lg font-semibold text-foreground">
            {isLoading ? "…" : unconfiguredPolicyCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">Legal Hold (보존 잠금)</div>
          <div
            className={cn(
              "mt-1 text-lg font-semibold",
              legalHoldCount > 0
                ? "text-amber-600 dark:text-amber-400"
                : "text-foreground",
            )}
          >
            {isLoading ? "…" : legalHoldCount}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">미매핑 (Unmapped)</div>
          <div className="mt-1 text-lg font-semibold text-muted-foreground">
            {isLoading ? "…" : unmappedCount}
          </div>
        </Card>
      </div>

      {/* 3. Empty State Informational Banner (when policies are unconfigured) */}
      {!isLoading && configuredPolicyCount === 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-xs text-muted-foreground bg-muted/5">
          <Info className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-semibold text-foreground">
              아직 활성화된 Data Lifecycle 정책이 없습니다.
            </div>
            <p className="text-muted-foreground leading-relaxed">
              현재는 12개 데이터 분류 및 읽기 전용 Dry Run 기반만 준비된 상태입니다.
              실제 보존기간과 자동 정리는 별도 승인 후 활성화됩니다.
            </p>
          </div>
        </div>
      ) : null}

      {/* 4. Data Class Overview Table */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Archive className="h-4 w-4" />
            <span>데이터 분류 및 보존 주기 현황 ({classifications.length}개 분류)</span>
          </div>
        </div>

        {classifications.length === 0 && !isLoading ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            조회된 데이터 분류가 없습니다.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="border-b bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Data Class / 명칭</th>
                  <th className="px-3 py-2 text-left font-medium">분류 상태</th>
                  <th className="px-3 py-2 text-left font-medium">연결 테이블 / 소스</th>
                  <th className="px-3 py-2 text-left font-medium">보존 정책 상태</th>
                  <th className="px-3 py-2 text-left font-medium">보존 모드</th>
                  <th className="px-3 py-2 text-left font-medium">보존 주기</th>
                  <th className="px-3 py-2 text-left font-medium">Legal Hold</th>
                  <th className="px-3 py-2 text-right font-medium">Dry Run</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {classifications.map((item) => {
                  const meta = DATA_CLASS_META[item.dataClass];
                  const policy = item.policy;
                  const isUnmapped = item.status === "unmapped";
                  const isFileBased = item.status === "file_based";

                  return (
                    <tr
                      key={item.dataClass}
                      className="hover:bg-muted/10 transition-colors"
                    >
                      {/* 1. 명칭 및 코드 */}
                      <td className="px-3 py-2.5">
                        <div className="font-semibold text-foreground">
                          {meta?.koreanName ?? item.dataClass}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="font-mono text-xs text-muted-foreground">
                            {item.dataClass}
                          </span>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground">{meta?.category}</span>
                        </div>
                      </td>

                      {/* 2. 분류 상태 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <ClassificationStatusBadge status={item.status} />
                      </td>

                      {/* 3. 연결 테이블 / 소스 */}
                      <td className="px-3 py-2.5">
                        {isUnmapped ? (
                          <div className="space-y-0.5">
                            <span className="font-mono text-muted-foreground">연결 테이블 없음</span>
                            <p className="text-muted-foreground text-xs">
                              아직 실제 저장 테이블과 연결되지 않음
                            </p>
                          </div>
                        ) : isFileBased ? (
                          <div className="space-y-0.5">
                            <span className="font-medium text-foreground">파일시스템 디렉터리</span>
                            <p className="text-muted-foreground text-xs">/data/backups (mtime 기준)</p>
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            <span className="font-mono font-medium text-foreground">
                              {item.tables.map((t) => t.table).join(", ")}
                            </span>
                            {item.dataClass === "verified_knowledge" ? (
                              <span className="inline-block rounded bg-emerald-500/10 px-1 py-0.2 text-emerald-600 dark:text-emerald-400 font-medium">
                                archivedAt 지원
                              </span>
                            ) : null}
                          </div>
                        )}
                      </td>

                      {/* 4. 정책 설정 여부 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {policy ? (
                          policy.enabled ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                              <CheckCircle2 className="h-3 w-3" />
                              활성 (Enabled)
                            </span>
                          ) : (
                            <span className="text-muted-foreground">비활성 (Disabled)</span>
                          )
                        ) : (
                          <span className="text-muted-foreground">미설정</span>
                        )}
                      </td>

                      {/* 5. 보존 모드 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {policy ? (
                          <RetentionModeBadge mode={policy.retentionMode} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* 6. 보존 주기 (일수) */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {policy ? (
                          policy.retentionMode === "retain" ? (
                            <span className="text-muted-foreground">영구 보존</span>
                          ) : policy.retentionMode === "archive_then_delete" ? (
                            <span>
                              {policy.archiveAfterDays ? `${policy.archiveAfterDays}일` : "—"} /{" "}
                              {policy.hardDeleteAfterDays ? `${policy.hardDeleteAfterDays}일` : "—"}
                            </span>
                          ) : (
                            <span>{policy.retentionDays ? `${policy.retentionDays}일` : "—"}</span>
                          )
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* 7. Legal Hold */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {policy?.legalHold ? (
                          <span className="inline-flex items-center gap-1 font-semibold text-amber-600 dark:text-amber-400">
                            <Lock className="h-3 w-3" />
                            보존 잠금
                          </span>
                        ) : policy ? (
                          <span className="text-muted-foreground">해제됨</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* 8. Dry Run 버튼 */}
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedDryRunClass(item.dataClass)}
                          className="h-7 text-xs gap-1"
                        >
                          <Play className="h-3 w-3 text-primary" />
                          Dry Run 보기
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 5. Dry-Run Inspection Dialog (ReadOnly Simulation) */}
      <Dialog
        open={selectedDryRunClass !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedDryRunClass(null);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Database className="h-5 w-5 text-primary" />
              <span>
                {selectedDryRunClass ? DATA_CLASS_META[selectedDryRunClass]?.koreanName : ""}{" "}
                — Dry Run 시뮬레이션 결과
              </span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              ⚠️ 읽기 전용 시뮬레이션입니다. 실제 데이터나 백업 파일은 삭제/변경되지 않습니다.
            </DialogDescription>
          </DialogHeader>

          {dryRunQuery.isLoading ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2 text-primary" />
              Dry Run 후보를 실시간 집계하는 중입니다...
            </div>
          ) : dryRunQuery.isError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive">
              <div className="font-semibold">Dry Run 시뮬레이션을 수행할 수 없습니다.</div>
              <p className="mt-1 text-muted-foreground">
                {describeApiError(dryRunQuery.error, "알 수 없는 오류가 발생했습니다.")}
              </p>
            </div>
          ) : dryRunQuery.data?.result ? (
            <DryRunDetailsView result={dryRunQuery.data.result} />
          ) : null}

          <div className="flex justify-end pt-2 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedDryRunClass(null)}
              className="h-8 text-xs"
            >
              닫기
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function DryRunDetailsView({ result }: { result: DryRunResult }) {
  const meta = DATA_CLASS_META[result.dataClass];
  const reasonMeta = DRY_RUN_REASON_DESCRIPTIONS[result.reason] ?? {
    label: result.reason,
    description: "서버에서 반환된 판정 결과입니다.",
    badgeVariant: "neutral",
  };

  return (
    <div className="space-y-3 text-xs">
      {/* 1. 기본 대상 정보 */}
      <div className="rounded-md border p-3 space-y-2 bg-muted/10">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-foreground">
            {meta?.koreanName} ({result.dataClass})
          </span>
          <ClassificationStatusBadge
            status={
              result.dataClass === "memory_summary"
                ? "unmapped"
                : result.dataClass === "backup_metadata"
                  ? "file_based"
                  : "mapped"
            }
          />
        </div>
        <div className="grid grid-cols-2 gap-2 text-muted-foreground pt-1 border-t">
          <div>
            대상 소스:{" "}
            <span className="font-mono text-foreground font-medium">
              {result.source || "—"}
            </span>
          </div>
          <div>
            예정 액션:{" "}
            <span className="font-semibold text-foreground">
              {result.action === "none"
                ? "조치 없음 (None)"
                : result.action === "retain"
                  ? "보존 유지 (Retain)"
                  : result.action === "archive"
                    ? "아카이브 대상 분류 (Archive)"
                    : result.action === "delete"
                      ? "삭제 대상 분류 (Delete)"
                      : "아카이브 대상 분류 (1단계: Archive)"}
            </span>
          </div>
        </div>
      </div>

      {/* 2. 후보 건수 및 영향 예측 */}
      <div className="rounded-md border p-3 space-y-2">
        <div className="font-semibold text-muted-foreground flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          정리 후보 집계 (Candidate Summary)
        </div>
        <div className="grid grid-cols-2 gap-3 py-1">
          <div className="rounded bg-muted/20 p-2.5">
            <span className="text-muted-foreground">정리 대상 후보 건수</span>
            <div className="mt-1 text-lg font-bold text-foreground">
              {result.candidateCount.toLocaleString()}
              <span className="text-xs font-normal text-muted-foreground ml-1">
                {result.dataClass === "backup_metadata" ? "개 파일" : "건"}
              </span>
            </div>
          </div>
          <div className="rounded bg-muted/20 p-2.5">
            <span className="text-muted-foreground">예상 영향 레코드</span>
            <div className="mt-1 text-lg font-bold text-foreground">
              {result.estimatedRows.toLocaleString()}
              <span className="text-xs font-normal text-muted-foreground ml-1">행</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1 border-t text-muted-foreground">
          <div>
            가장 오래된 레코드:{" "}
            <span className="font-medium text-foreground">
              {result.oldestCandidate
                ? `${formatDate(result.oldestCandidate)} (${relativeTime(result.oldestCandidate)})`
                : "—"}
            </span>
          </div>
          <div>
            가장 최근 레코드:{" "}
            <span className="font-medium text-foreground">
              {result.newestCandidate
                ? `${formatDate(result.newestCandidate)} (${relativeTime(result.newestCandidate)})`
                : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* 3. 판정 사유 및 Fail-Closed 상태 설명 */}
      <div className="rounded-md border p-3 space-y-1.5">
        <div className="font-semibold text-muted-foreground flex items-center gap-1">
          <Shield className="h-3.5 w-3.5" />
          판정 사유 (Fail-Closed Reason)
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span
            className={cn(
              "inline-flex items-center rounded px-2 py-0.5 font-semibold text-xs",
              reasonMeta.badgeVariant === "warning"
                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                : reasonMeta.badgeVariant === "success"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {reasonMeta.label}
          </span>
          <span className="font-mono text-muted-foreground text-xs">
            code: {result.reason}
          </span>
        </div>
        <p className="text-muted-foreground leading-relaxed pt-1">
          {reasonMeta.description}
        </p>
      </div>

      {/* 4. 안전 안내 */}
      <div className="rounded border border-dashed p-2.5 text-muted-foreground leading-relaxed">
        ℹ️ 본 시뮬레이션은 백엔드에서 후보 건수를 집계한 결과이며, 실제 정리 및 삭제 엔진은 별도 관리자 승인 배치 전까지 실행되지 않습니다.
      </div>
    </div>
  );
}
