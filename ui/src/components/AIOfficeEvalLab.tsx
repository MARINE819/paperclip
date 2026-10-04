import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Award,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  Flame,
  HelpCircle,
  RefreshCw,
  TrendingDown,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn, relativeTime } from "@/lib/utils";
import { describeApiError } from "@/api/client";
import {
  evalsApi,
  type BenchmarkSummaryEntry,
  type EvalRunStatus,
  type EvalRunSummary,
} from "@/api/evals";

export function EvalStatusBadge({ status }: { status: EvalRunStatus }) {
  const config: Record<EvalRunStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
    passed: {
      label: "통과",
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      icon: CheckCircle2,
    },
    failed: {
      label: "실패",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
      icon: XCircle,
    },
    error: {
      label: "오류",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
      icon: Flame,
    },
    judged_only: {
      label: "판정 전용 (검증 미완료)",
      className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      icon: HelpCircle,
    },
    running: {
      label: "실행 중",
      className: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
      icon: Activity,
    },
    queued: {
      label: "대기",
      className: "border-border bg-muted text-muted-foreground",
      icon: RefreshCw,
    },
  };

  const current = config[status] ?? {
    label: status,
    className: "border-border bg-muted text-muted-foreground",
    icon: HelpCircle,
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

export function AIOfficeEvalLab({
  agentNameById,
}: {
  agentNameById?: Map<string, string>;
}) {
  const [selectedProvider, setSelectedProvider] = useState<string>("all");
  const [showAllRuns, setShowAllRuns] = useState<boolean>(false);

  const summaryQuery = useQuery({
    queryKey: ["evals", "summary"],
    queryFn: () => evalsApi.getSummary(),
    refetchInterval: 30_000,
  });

  const benchmarksQuery = useQuery({
    queryKey: ["evals", "benchmarks"],
    queryFn: () => evalsApi.listBenchmarks(),
    refetchInterval: 60_000,
  });

  const runsQuery = useQuery({
    queryKey: ["evals", "runs", { limit: 20 }],
    queryFn: () => evalsApi.listRuns({ limit: 20 }),
    refetchInterval: 30_000,
  });

  const failedRunsQuery = useQuery({
    queryKey: ["evals", "runs", { status: "failed", limit: 10 }],
    queryFn: () => evalsApi.listRuns({ status: "failed", limit: 10 }),
    refetchInterval: 30_000,
  });

  const summary = summaryQuery.data?.summary ?? [];
  const benchmarks = benchmarksQuery.data?.benchmarks ?? [];
  const runs = runsQuery.data?.runs ?? [];
  const failedRuns = failedRunsQuery.data?.runs ?? [];

  // Filter models/providers for side-by-side comparison
  const providers = useMemo(() => {
    const set = new Set<string>();
    for (const item of summary) {
      if (item.modelProvider) set.add(item.modelProvider);
    }
    return Array.from(set);
  }, [summary]);

  const filteredSummary = useMemo(() => {
    if (selectedProvider === "all") return summary;
    return summary.filter((item) => item.modelProvider === selectedProvider);
  }, [summary, selectedProvider]);

  // Server-computed aggregates across summary
  const totals = useMemo(() => {
    let totalRuns = 0;
    let passedRuns = 0;
    let failedRuns = 0;
    for (const item of summary) {
      totalRuns += item.totalRuns;
      passedRuns += item.passedRuns;
      failedRuns += item.failedRuns;
    }
    const overallPassRate = totalRuns > 0 ? (passedRuns / totalRuns) * 100 : null;
    const overallFailRate = totalRuns > 0 ? (failedRuns / totalRuns) * 100 : null;
    return { totalRuns, passedRuns, failedRuns, overallPassRate, overallFailRate };
  }, [summary]);

  const isLoading = summaryQuery.isLoading || benchmarksQuery.isLoading || runsQuery.isLoading;
  const isError = summaryQuery.isError || benchmarksQuery.isError || runsQuery.isError;
  const activeError = summaryQuery.error || runsQuery.error || benchmarksQuery.error;
  const errorMessage = activeError
    ? describeApiError(activeError, "Eval API 응답 실패")
    : null;

  return (
    <Card className="space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold tracking-tight">
              Control Center — Agent Quality & Simulation Lab (F-04)
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            모델 품질, 벤치마크 통과율 및 회귀 감지를 실시간 관측합니다. (모든 수치는 서버 집계 기준)
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            summaryQuery.refetch();
            benchmarksQuery.refetch();
            runsQuery.refetch();
            failedRunsQuery.refetch();
          }}
          disabled={isLoading}
          className="h-8 gap-1.5 self-start sm:self-auto"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      {isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive">
          <div className="font-semibold">Eval 데이터를 불러올 수 없습니다.</div>
          <p className="mt-1 text-muted-foreground">
            {errorMessage ?? "서버 연결을 확인하거나 나중에 다시 시도해 주세요."}
          </p>
        </div>
      ) : null}

      {/* 1. Agent Quality Summary Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">전체 실행</div>
          <div className="mt-1 text-lg font-semibold">
            {isLoading ? "…" : totals.totalRuns}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">평균 성공률</div>
          <div className="mt-1 text-lg font-semibold text-emerald-600 dark:text-emerald-400">
            {isLoading
              ? "…"
              : totals.overallPassRate != null
                ? `${totals.overallPassRate.toFixed(1)}%`
                : "—"}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">실패율</div>
          <div className="mt-1 text-lg font-semibold text-destructive">
            {isLoading
              ? "…"
              : totals.overallFailRate != null
                ? `${totals.overallFailRate.toFixed(1)}%`
                : "—"}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">활성 벤치마크</div>
          <div className="mt-1 text-lg font-semibold">
            {isLoading ? "…" : benchmarks.length}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">최근 실패 건수</div>
          <div className="mt-1 text-lg font-semibold">
            {isLoading ? "…" : failedRuns.length}
          </div>
        </Card>
      </div>

      {/* 2. Regression Alerts Bar */}
      <div className="rounded-lg border p-3 text-xs">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
          <span>Regression Alerts (회귀 감지 알림)</span>
        </div>
        {failedRuns.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            {failedRuns.slice(0, 3).map((fail) => (
              <div
                key={fail.id}
                className="flex items-center justify-between rounded bg-muted/40 p-2"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-destructive">
                    [{fail.modelProvider}/{fail.modelName}]
                  </span>
                  <span>{fail.benchmarkKey}</span>
                  <span className="text-muted-foreground">
                    ({fail.failureType ?? "실패"})
                  </span>
                </div>
                <EvalStatusBadge status={fail.status} />
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-1 text-muted-foreground">
            최근 감지된 모델 품질 회귀 또는 실행 실패가 없습니다. (안정 상태)
          </div>
        )}
      </div>

      {/* 3. Benchmark Summary / Model Comparison Grid */}
      <div className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Award className="h-4 w-4" />
            <span>Benchmark 모델 비교 (Claude vs GPT vs Gemini vs Hermes)</span>
          </div>
          {providers.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              <Button
                variant={selectedProvider === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedProvider("all")}
                className="h-6 text-xs px-2"
              >
                전체
              </Button>
              {providers.map((p) => (
                <Button
                  key={p}
                  variant={selectedProvider === p ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedProvider(p)}
                  className="h-6 text-xs px-2"
                >
                  {p}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        {filteredSummary.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            벤치마크 평가 요약 데이터가 아직 등록되지 않았습니다.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="border-b bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">벤치마크</th>
                  <th className="px-3 py-2 text-left font-medium">제공자</th>
                  <th className="px-3 py-2 text-left font-medium">모델</th>
                  <th className="px-3 py-2 text-right font-medium">전체</th>
                  <th className="px-3 py-2 text-right font-medium">성공</th>
                  <th className="px-3 py-2 text-right font-medium">실패</th>
                  <th className="px-3 py-2 text-right font-medium">성공률</th>
                  <th className="px-3 py-2 text-left font-medium">최근 상태</th>
                  <th className="px-3 py-2 text-left font-medium">최근 실행</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredSummary.map((item, idx) => (
                  <tr key={`${item.benchmarkKey}-${item.modelProvider}-${item.modelName}-${idx}`} className="hover:bg-muted/10">
                    <td className="px-3 py-2 font-medium">
                      {item.benchmarkKey} (v{item.benchmarkVersion})
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{item.modelProvider}</td>
                    <td className="px-3 py-2 font-medium">{item.modelName}</td>
                    <td className="px-3 py-2 text-right">{item.totalRuns}</td>
                    <td className="px-3 py-2 text-right text-emerald-600 dark:text-emerald-400">
                      {item.passedRuns}
                    </td>
                    <td className="px-3 py-2 text-right text-destructive">{item.failedRuns}</td>
                    <td className="px-3 py-2 text-right font-semibold">
                      {(item.passRate * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-2">
                      {item.latestStatus ? (
                        <EvalStatusBadge status={item.latestStatus} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {item.latestRunAt
                        ? relativeTime(item.latestRunAt)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 4. Recent Eval Runs (Detail Table) */}
      <div className="space-y-2 border-t pt-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Activity className="h-4 w-4" />
            <span>최근 Eval 실행 내역 ({runs.length}건)</span>
          </div>
          {runs.length > 5 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAllRuns(!showAllRuns)}
              className="h-6 text-xs gap-1"
            >
              {showAllRuns ? (
                <>
                  접기 <ChevronUp className="h-3 w-3" />
                </>
              ) : (
                <>
                  더보기 ({runs.length}) <ChevronDown className="h-3 w-3" />
                </>
              )}
            </Button>
          ) : null}
        </div>

        {runs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            실행된 Eval 내역이 없습니다.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="border-b bg-muted/30 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">에이전트</th>
                  <th className="px-3 py-2 text-left font-medium">모델</th>
                  <th className="px-3 py-2 text-left font-medium">태스크/벤치마크</th>
                  <th className="px-3 py-2 text-left font-medium">상태</th>
                  <th className="px-3 py-2 text-right font-medium">정확도</th>
                  <th className="px-3 py-2 text-right font-medium">소요 시간</th>
                  <th className="px-3 py-2 text-right font-medium">비용</th>
                  <th className="px-3 py-2 text-left font-medium">일시</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(showAllRuns ? runs : runs.slice(0, 5)).map((run) => {
                  const agentName = run.agentId
                    ? agentNameById?.get(run.agentId) ?? run.agentId.slice(0, 8)
                    : "공통";
                  const cost =
                    run.costActual != null
                      ? `$${run.costActual.toFixed(4)}`
                      : run.costEstimated != null
                        ? `~$${run.costEstimated.toFixed(4)}`
                        : "—";
                  return (
                    <tr key={run.id} className="hover:bg-muted/10">
                      <td className="px-3 py-2 font-medium">{agentName}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {run.modelProvider}/{run.modelName}
                      </td>
                      <td className="px-3 py-2 font-medium">{run.benchmarkKey}</td>
                      <td className="px-3 py-2">
                        <EvalStatusBadge status={run.status} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {run.accuracy != null ? `${(run.accuracy * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {run.latencyMs != null ? `${Math.round(run.latencyMs)}ms` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">{cost}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {relativeTime(run.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
