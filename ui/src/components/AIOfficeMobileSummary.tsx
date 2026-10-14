import { useEffect, useMemo, useState } from "react";
import type { Agent, Approval, CostByAgentModel, DashboardSummary, Issue, IssueComment, IssueWorkProduct } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { approvalsApi } from "@/api/approvals";
import { companiesApi } from "@/api/companies";
import { webauthnApi } from "@/api/webauthn";
import { isMuted, toggleMuted } from "@/lib/audio-chime";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { VoiceCommandBar } from "@/components/VoiceCommandBar";
import { AIOfficeJarvisTaskInstruction } from "@/components/AIOfficeJarvisTaskInstruction";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatCents, cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cpu,
  DollarSign,
  ExternalLink,
  FileCheck,
  FileText,
  Fingerprint,
  GitBranch,
  GitCommit,
  Globe,
  Package,
  Server,
  Shield,
  ShieldAlert,
  Smartphone,
  Volume2,
  VolumeX,
  Wrench,
  type LucideIcon,
} from "lucide-react";

function workProductTypeIcon(type: string): LucideIcon {
  switch (type) {
    case "document":
      return FileText;
    case "pull_request":
    case "branch":
      return GitBranch;
    case "commit":
      return GitCommit;
    case "preview_url":
      return Globe;
    case "runtime_service":
      return Server;
    default:
      return Package;
  }
}

function workProductStatusBadge(wp: IssueWorkProduct) {
  const isApproved = wp.status === "approved" || wp.reviewState === "approved";
  const isNeedsReview = wp.status === "ready_for_review" || wp.reviewState === "needs_board_review";
  const isFailed = wp.status === "failed";
  const isChangesRequested = wp.status === "changes_requested" || wp.reviewState === "changes_requested";

  let label = wp.status;
  let colorClass = "border-border bg-muted text-muted-foreground";

  if (isApproved) {
    label = "승인됨";
    colorClass = "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  } else if (isNeedsReview) {
    label = "검토 대기";
    colorClass = "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  } else if (isFailed) {
    label = "실패";
    colorClass = "border-destructive/30 bg-destructive/10 text-destructive";
  } else if (isChangesRequested) {
    label = "수정 요청";
    colorClass = "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  } else if (wp.status === "active") {
    label = "작업 중";
    colorClass = "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400";
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        colorClass,
      )}
    >
      {label}
    </span>
  );
}

function MobileSingleIssueWorkProducts({
  issueId,
  agentName,
}: {
  issueId: string;
  agentName?: string;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["mobile-work-products", issueId],
    queryFn: () => issuesApi.listWorkProducts(issueId),
  });

  if (isLoading) {
    return (
      <div className="rounded border border-dashed p-2.5 text-xs text-muted-foreground">
        산출물 데이터 로딩 중...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
        산출물 데이터 조회 실패
      </div>
    );
  }

  const workProducts = data ?? [];

  if (workProducts.length === 0) {
    return (
      <div className="rounded border border-dashed p-2.5 text-center text-xs text-muted-foreground">
        등록된 산출물 없음
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {workProducts.map((wp) => {
        const Icon = workProductTypeIcon(wp.type);
        const targetUrl = wp.url || (wp.issueId ? `/issues/${wp.issueId}` : null);

        return (
          <div
            key={wp.id}
            data-testid={`mobile-work-product-item-${wp.id}`}
            className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 p-2.5 text-xs shadow-xs"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{wp.title}</div>
                {agentName ? (
                  <div className="truncate text-muted-foreground">담당: {agentName}</div>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {workProductStatusBadge(wp)}
              {targetUrl ? (
                <a
                  href={targetUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="산출물 열기"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">열기</span>
                </a>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MobileWorkProductsSection({
  distinctIssueIds,
  agentNameByIssueId,
}: {
  distinctIssueIds: string[];
  agentNameByIssueId: Map<string, string>;
}) {
  let hasClient = false;
  try {
    useQueryClient();
    hasClient = true;
  } catch {
    hasClient = false;
  }

  return (
    <Card data-testid="mobile-work-products-section">
      <CardHeader className="p-4 pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Package className="h-4 w-4 text-primary" aria-hidden="true" />
            <CardTitle className="text-sm font-semibold">최근 업무 산출물 (Work Products)</CardTitle>
          </div>
          <span className="text-xs text-muted-foreground">
            {distinctIssueIds.length > 0 ? `${distinctIssueIds.length}개 이슈 연동` : "진행 중 이슈 없음"}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-2">
        {!hasClient ? (
          <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
            {distinctIssueIds.length === 0
              ? "현재 활성 이슈에서 생산된 산출물이 없습니다 (진행 중인 이슈 없음)"
              : "산출물 클라이언트 준비 중..."}
          </div>
        ) : distinctIssueIds.length === 0 ? (
          <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
            현재 활성 이슈에서 생산된 산출물이 없습니다 (진행 중인 이슈 없음)
          </div>
        ) : (
          distinctIssueIds.map((issueId) => (
            <MobileSingleIssueWorkProducts
              key={issueId}
              issueId={issueId}
              agentName={agentNameByIssueId.get(issueId)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}


export interface AIOfficeMobileSummaryProps {
  companyId?: string | null;
  agents: Agent[];
  liveRuns: LiveRunForIssue[];
  pendingApprovals: Approval[];
  inReviewIssues?: Issue[];
  completedIssues?: Issue[];
  errorAgents: Agent[];
  dashboardData?: DashboardSummary | null;
  costByAgentModel?: CostByAgentModel[];
  onSelectAgent?: (agentId: string) => void;
  jarvisReportComments?: Map<string, IssueComment>;
}

export function AIOfficeMobileSummary({
  companyId,
  agents,
  liveRuns,
  pendingApprovals,
  inReviewIssues = [],
  completedIssues = [],
  errorAgents,
  dashboardData,
  costByAgentModel = [],
  onSelectAgent,
  jarvisReportComments,
}: AIOfficeMobileSummaryProps) {
  const effectiveCompanyId =
    companyId ??
    agents[0]?.companyId ??
    pendingApprovals[0]?.companyId ??
    dashboardData?.companyId ??
    null;

  const queryClient = useQueryClient();

  const [soundMuted, setSoundMuted] = useState(() => isMuted());
  const handleToggleSound = () => {
    const next = toggleMuted();
    setSoundMuted(next);
  };

  const [isStandalone, setIsStandalone] = useState(() => {
    if (typeof window === "undefined") return false;
    return Boolean(
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      (navigator as unknown as { standalone?: boolean })?.standalone,
    );
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(display-mode: standalone)");
    const handler = (e: MediaQueryListEvent) => {
      setIsStandalone(e.matches || Boolean((navigator as unknown as { standalone?: boolean })?.standalone));
    };
    mediaQuery.addEventListener?.("change", handler);
    return () => mediaQuery.removeEventListener?.("change", handler);
  }, []);

  const {
    data: webauthnCredentials,
    isLoading: isWebauthnLoading,
    isError: isWebauthnError,
  } = useQuery({
    queryKey: ["webauthn-credentials", effectiveCompanyId],
    queryFn: () => (effectiveCompanyId ? webauthnApi.listCredentials(effectiveCompanyId) : Promise.resolve([])),
    enabled: !!effectiveCompanyId,
  });

  const [emergencyConfirmOpen, setEmergencyConfirmOpen] = useState(false);
  const emergencyPauseMutation = useMutation({
    mutationFn: () => {
      if (!effectiveCompanyId) throw new Error("No company id");
      return companiesApi.emergencyPause(effectiveCompanyId);
    },
    onSuccess: () => {
      setEmergencyConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: ["companies"] });
    },
  });

  const [selectedApproval, setSelectedApproval] = useState<Approval | null>(null);
  const [decisionNote, setDecisionNote] = useState("");

  const approveMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalsApi.approve(id, note),
    onSuccess: () => {
      setSelectedApproval(null);
      setDecisionNote("");
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalsApi.reject(id, note),
    onSuccess: () => {
      setSelectedApproval(null);
      setDecisionNote("");
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
  });

  const liveRunByAgentId = useMemo(
    () => new Map(liveRuns.map((run) => [run.agentId, run])),
    [liveRuns],
  );

  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

  const jarvisAgent = useMemo(
    () => agents.find((agent) => agent.name.toUpperCase() === "JARVIS") ?? null,
    [agents],
  );

  const costModelByAgentId = useMemo(
    () => new Map(costByAgentModel.map((row) => [row.agentId, row])),
    [costByAgentModel],
  );

  const distinctIssueIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const run of liveRuns) {
      if (run.issueId && !seen.has(run.issueId)) {
        seen.add(run.issueId);
        ids.push(run.issueId);
      }
    }
    for (const issue of inReviewIssues) {
      if (issue.id && !seen.has(issue.id)) {
        seen.add(issue.id);
        ids.push(issue.id);
      }
    }
    return ids;
  }, [liveRuns, inReviewIssues]);

  const agentNameByIssueId = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of liveRuns) {
      if (run.issueId && !map.has(run.issueId)) {
        const agent = agentById.get(run.agentId);
        map.set(run.issueId, agent?.name ?? run.agentName);
      }
    }
    for (const issue of inReviewIssues) {
      if (issue.id && !map.has(issue.id) && issue.assigneeAgentId) {
        const agent = agentById.get(issue.assigneeAgentId);
        if (agent) map.set(issue.id, agent.name);
      }
    }
    return map;
  }, [liveRuns, inReviewIssues, agentById]);

  const pendingApprovalsCount = pendingApprovals.filter(
    (a) =>
      (a as { effectiveStatus?: string }).effectiveStatus === "pending" ||
      a.status === "pending" ||
      a.status === "revision_requested",
  ).length;

  const monthSpendCents = dashboardData?.costs.monthSpendCents ?? null;
  const monthBudgetCents = dashboardData?.costs.monthBudgetCents ?? null;
  const monthUtilization = dashboardData?.costs.monthUtilizationPercent ?? null;

  return (
    <div className="space-y-4 pb-8" data-testid="ai-office-mobile-summary">
      {/* 0. 모바일 경영진 거버넌스 헤더 (Mobile Executive Governance Header) */}
      <Card className="border-border bg-card shadow-xs" data-testid="mobile-governance-header">
        <CardContent className="flex flex-col gap-2.5 p-3">
          {/* 상단 행: 브랜드/타이틀, PWA standalone 상태, 음소거 토글 버튼 */}
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <Shield className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="truncate text-xs font-semibold text-foreground">
                경영진 거버넌스 사령탑
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {/* PWA Standalone 상태 */}
              <div
                data-testid="mobile-pwa-status"
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
              >
                <Smartphone className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{isStandalone ? "PWA Standalone" : "Browser Web"}</span>
              </div>

              {/* 사운드 토글 버튼 (최소 h-9 w-9, aria-pressed={soundMuted}) */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 w-9 min-h-9 min-w-9 p-0 shrink-0"
                onClick={handleToggleSound}
                aria-pressed={soundMuted}
                aria-label={soundMuted ? "알림음 음소거 해제" : "알림음 음소거"}
                title={soundMuted ? "알림음 음소거 해제" : "알림음 음소거"}
                data-testid="mobile-sound-toggle-btn"
              >
                {soundMuted ? (
                  <VolumeX className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <Volume2 className="h-4 w-4 text-primary" aria-hidden="true" />
                )}
                <span className="sr-only">{soundMuted ? "음소거 상태" : "알림음 활성 상태"}</span>
              </Button>
            </div>
          </div>

          {/* 중간 행: WebAuthn 생체 인증 상태 (로딩/등록됨/미등록/에러) */}
          <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2 text-xs">
            <div className="flex items-center gap-1.5 min-w-0 text-muted-foreground">
              <Fingerprint className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span className="font-medium text-foreground">생체 인증(WebAuthn):</span>
            </div>

            <div data-testid="mobile-webauthn-status" className="shrink-0">
              {isWebauthnLoading && !!effectiveCompanyId ? (
                <span
                  data-testid="mobile-webauthn-loading"
                  className="inline-flex items-center rounded-full border border-border bg-muted/30 px-2 py-0.5 text-xs font-medium text-muted-foreground"
                >
                  확인 중...
                </span>
              ) : isWebauthnError ? (
                <span
                  data-testid="mobile-webauthn-error"
                  className="inline-flex items-center rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
                >
                  조회 실패
                </span>
              ) : (webauthnCredentials?.length ?? 0) > 0 ? (
                <span
                  data-testid="mobile-webauthn-registered"
                  className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                >
                  등록됨 ({webauthnCredentials?.length}개)
                </span>
              ) : (
                <span
                  data-testid="mobile-webauthn-unregistered"
                  className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground"
                >
                  미등록
                </span>
              )}
            </div>
          </div>

          {/* 하단 행: 모바일 승인 및 모바일 설정 네비게이션 링크 (min-h-9 준수) */}
          <div className="flex items-center gap-2 border-t border-border/40 pt-2">
            <Button size="sm" variant="outline" asChild className="min-h-9 flex-1 text-xs">
              <Link to="/mobile/approvals" data-testid="mobile-header-approvals-link">
                모바일 승인
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild className="min-h-9 flex-1 text-xs">
              <Link to="/mobile/settings" data-testid="mobile-header-settings-link">
                모바일 설정
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 0.5 모바일 경영진 안전 제어 및 음성 사령탑 바 (Executive Safe Action & Voice Bar) */}
      <Card className="border-border bg-card shadow-xs" data-testid="mobile-safe-action-bar">
        <CardContent className="flex flex-col gap-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" aria-hidden="true" />
              <span className="text-xs font-semibold text-foreground">사령탑 제어 & 긴급 조치</span>
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-7 px-2.5 text-xs font-semibold"
              disabled={!effectiveCompanyId || emergencyPauseMutation.isPending}
              onClick={() => setEmergencyConfirmOpen(true)}
              data-testid="mobile-emergency-stop-btn"
            >
              긴급 정지 (Emergency Stop)
            </Button>
          </div>

          {emergencyPauseMutation.isSuccess ? (
            <div className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive" data-testid="mobile-emergency-success-notice">
              회사가 긴급 정지되었습니다. (모든 에이전트 실행 중단)
            </div>
          ) : null}

          {emergencyPauseMutation.isError ? (
            <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" data-testid="mobile-emergency-error-notice">
              긴급 정지 요청 실패: 다시 시도하십시오.
            </div>
          ) : null}

          {/* 기존 VoiceCommandBar 마운트 */}
          {effectiveCompanyId ? (
            <div className="border-t pt-2" data-testid="mobile-voice-section">
              <VoiceCommandBar companyId={effectiveCompanyId} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* 0.5 자비스 업무 지시 (JARVIS Task Instruction) */}
      <AIOfficeJarvisTaskInstruction
        companyId={effectiveCompanyId}
        jarvisAgent={jarvisAgent}
        agentById={agentById}
      />

      {/* 1. 경영진 핵심 브리핑 바 (Top Executive Metrics) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {/* 승인 대기 카드 */}
        <div
          className={cn(
            "flex flex-col gap-1 rounded-lg border p-3 text-xs",
            pendingApprovalsCount > 0
              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-border/60 bg-muted/20",
          )}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-muted-foreground">승인 대기</span>
            <Clock className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="text-xl font-bold">{pendingApprovalsCount}건</div>
          {pendingApprovalsCount > 0 ? (
            <Link
              to="/mobile/approvals"
              className="mt-1 flex items-center font-medium text-primary hover:underline"
            >
              모바일 승인 →
            </Link>
          ) : (
            <span className="text-muted-foreground">대기 없음</span>
          )}
        </div>

        {/* 검토 대기 카드 */}
        <div
          data-testid="mobile-in-review-metric"
          className={cn(
            "flex flex-col gap-1 rounded-lg border p-3 text-xs",
            inReviewIssues.length > 0
              ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
              : "border-border/60 bg-muted/20",
          )}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-muted-foreground">검토 대기</span>
            <FileCheck className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="text-xl font-bold">{inReviewIssues.length}건</div>
          {inReviewIssues.length > 0 ? (
            <span className="text-muted-foreground">독립 검토 대기</span>
          ) : (
            <span className="text-muted-foreground">대기 없음</span>
          )}
        </div>

        {/* 차단/오류 카드 */}
        <div
          className={cn(
            "flex flex-col gap-1 rounded-lg border p-3 text-xs",
            errorAgents.length > 0
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border/60 bg-muted/20",
          )}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-muted-foreground">오류/차단</span>
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="text-xl font-bold">{errorAgents.length}명</div>
          <span className="text-muted-foreground">
            {errorAgents.length > 0 ? "즉시 점검 필요" : "모든 시스템 정상"}
          </span>
        </div>

        {/* 활동 중인 직원 카드 */}
        <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-muted-foreground">근무 중인 AI</span>
            <Activity className="h-4 w-4 text-emerald-500" aria-hidden="true" />
          </div>
          <div className="text-xl font-bold">{liveRuns.length}명</div>
          <span className="text-muted-foreground">전체 {agents.length}명 중</span>
        </div>

        {/* 당월 누적 비용 카드 */}
        <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-muted-foreground">당월 지출</span>
            <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="text-xl font-bold">
            {monthSpendCents != null ? formatCents(monthSpendCents) : "정보 없음"}
          </div>
          <span className="text-muted-foreground">
            {monthBudgetCents != null ? `예산 ${formatCents(monthBudgetCents)}` : "예산 미설정"}
            {monthUtilization != null ? ` (${monthUtilization}%)` : ""}
          </span>
        </div>
      </div>

      {/* 2. 승인 대기 긴급 액션 바 (있을 때만 표시) */}
      {pendingApprovalsCount > 0 ? (
        <Card className="border-amber-500/40 bg-amber-500/5" data-testid="mobile-pending-approvals-card">
          <CardHeader className="p-3 pb-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <CardTitle className="text-xs font-semibold text-amber-900 dark:text-amber-100">
                  CEO 승인 대기 안건 ({pendingApprovalsCount}건)
                </CardTitle>
              </div>
              <Link
                to="/mobile/approvals"
                className="text-xs font-medium text-primary hover:underline"
              >
                전체 콘솔 →
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 p-3 pt-1">
            {pendingApprovals
              .filter(
                (a) =>
                  (a as { effectiveStatus?: string }).effectiveStatus === "pending" ||
                  a.status === "pending" ||
                  a.status === "revision_requested",
              )
              .map((approval) => (
                <div
                  key={approval.id}
                  data-testid={`mobile-pending-approval-item-${approval.id}`}
                  className="flex flex-col gap-1.5 rounded-lg border border-amber-500/20 bg-background/90 p-2.5 text-xs shadow-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground truncate">
                      {approval.type}
                      {approval.status === "revision_requested" && (
                        <span className="ml-1.5 rounded bg-amber-500/10 px-1 py-0.5 text-xs font-normal text-amber-600 dark:text-amber-400">
                          수정 요청
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground shrink-0">
                      {approval.requestedByAgentId
                        ? agentById.get(approval.requestedByAgentId)?.name ?? approval.requestedByAgentId
                        : "시스템/운영자"}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t pt-1.5">
                    <span className="text-muted-foreground font-mono">ID: {approval.id.slice(0, 8)}</span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setSelectedApproval(approval);
                          setDecisionNote("");
                        }}
                        data-testid={`mobile-approval-review-btn-${approval.id}`}
                      >
                        신속 검토
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="h-7 px-2 text-xs"
                        disabled={rejectMutation.isPending}
                        onClick={() => rejectMutation.mutate({ id: approval.id })}
                        data-testid={`mobile-approval-quick-reject-btn-${approval.id}`}
                      >
                        반려
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className="h-7 px-2 text-xs font-semibold"
                        disabled={approveMutation.isPending}
                        onClick={() => approveMutation.mutate({ id: approval.id })}
                        data-testid={`mobile-approval-quick-approve-btn-${approval.id}`}
                      >
                        승인
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
          </CardContent>
        </Card>
      ) : null}

      {/* 2.5 독립 검토 대기 업무 (In-Review Queue) */}
      {inReviewIssues.length > 0 ? (
        <Card className="border-sky-500/40 bg-sky-500/5" data-testid="mobile-in-review-card">
          <CardHeader className="p-3 pb-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCheck className="h-4 w-4 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                <CardTitle className="text-xs font-semibold text-sky-900 dark:text-sky-100">
                  독립 검토 대기 업무 ({inReviewIssues.length}건)
                </CardTitle>
              </div>
              <span className="text-xs text-muted-foreground">검토자 대기</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 p-3 pt-1">
            {inReviewIssues.map((issue) => {
              const reportComment = jarvisReportComments?.get(issue.id);
              const isJarvisReport = Boolean(reportComment);
              return (
                <a
                  key={issue.id}
                  href={isJarvisReport && reportComment ? `/issues/${issue.id}#comment-${reportComment.id}` : `/issues/${issue.id}`}
                  data-testid={`mobile-in-review-item-${issue.id}`}
                  className={`flex flex-col gap-1 rounded-lg border p-2.5 text-xs shadow-xs transition-colors ${
                    isJarvisReport
                      ? "border-primary/40 bg-background/90 hover:border-primary/60"
                      : "border-sky-500/20 bg-background/90 hover:border-sky-500/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground truncate">
                      {issue.identifier ? `${issue.identifier} · ` : ""}{issue.title}
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>담당: {issue.assigneeAgentId ? (agentById.get(issue.assigneeAgentId)?.name ?? "AI 에이전트") : "미할당"}</span>
                    {isJarvisReport ? (
                      <span
                        className="rounded bg-primary/20 px-1.5 py-0.5 text-primary font-medium"
                        data-testid={`mobile-jarvis-report-badge-${issue.id}`}
                      >
                        JARVIS 최종 보고
                      </span>
                    ) : (
                      <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-600 dark:text-sky-400 font-medium">
                        검토 대기
                      </span>
                    )}
                  </div>
                </a>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {/* 3. 실시간 근무 현황 (Active AI Employees & Execution Observability) */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">실시간 근무 현황</CardTitle>
            <span className="text-xs text-muted-foreground">{liveRuns.length}명 실행 중</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-2.5 p-4 pt-2">
          {liveRuns.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              현재 실행 중인 AI 직원이 없습니다 (모두 대기 상태입니다)
            </div>
          ) : (
            liveRuns.map((run) => {
              const agent = agentById.get(run.agentId);
              const costRow = costModelByAgentId.get(run.agentId);
              const adapterConfig = (agent?.adapterConfig ?? {}) as Record<string, unknown>;
              const configuredModel =
                typeof adapterConfig.model === "string" && adapterConfig.model.trim()
                  ? adapterConfig.model
                  : null;

              const actualExecutor = run.adapterType || agent?.adapterType || "정보 없음";
              const model = configuredModel || costRow?.model || "정보 없음";
              const taskSummary =
                run.currentStatusMessage || run.triggerDetail || run.lastAssistantSnippet || "작업 수행 중";

              return (
                <div
                  key={run.id}
                  onClick={() => onSelectAgent?.(run.agentId)}
                  className="flex flex-col gap-2 rounded-lg border border-border/70 bg-card p-3 text-xs shadow-xs transition-colors hover:bg-muted/30 cursor-pointer"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-semibold text-foreground">
                      <Bot className="h-4 w-4 text-primary" aria-hidden="true" />
                      <span>{agent?.name ?? run.agentName}</span>
                      <span className="font-normal text-muted-foreground">
                        ({agent?.title ?? agent?.role ?? "AI"})
                      </span>
                    </div>
                    <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      근무 중
                    </span>
                  </div>

                  {/* 수행 업무 요약 */}
                  <div className="rounded bg-muted/40 p-2 font-medium text-foreground">
                    {taskSummary}
                  </div>

                  {/* 실행 두뇌 / 모델 / 도구 메타데이터 칩 */}
                  <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                    <div className="flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 font-mono">
                      <Cpu className="h-3 w-3" aria-hidden="true" />
                      <span>{actualExecutor}</span>
                    </div>

                    <div className="flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 font-mono">
                      <span>{model}</span>
                    </div>

                    {run.currentToolName ? (
                      <div className="flex items-center gap-1 rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 font-mono text-blue-600 dark:text-blue-400">
                        <Wrench className="h-3 w-3" aria-hidden="true" />
                        <span>{run.currentToolName}</span>
                      </div>
                    ) : null}

                    {run.issueId ? (
                      <a
                        href={`/issues/${run.issueId}`}
                        onClick={(e) => e.stopPropagation()}
                        data-testid={`mobile-live-run-issue-link-${run.issueId}`}
                        className="flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 font-mono text-muted-foreground hover:text-foreground hover:bg-muted"
                      >
                        <FileCheck className="h-3 w-3" aria-hidden="true" />
                        <span>Issue 연동됨</span>
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* 4. 오류 및 차단 직원 목록 (있을 때만 표시) */}
      {errorAgents.length > 0 ? (
        <Card className="border-destructive/40">
          <CardHeader className="p-4 pb-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
              <CardTitle className="text-sm font-semibold text-destructive">
                점검 및 조치 필요 AI 직원 ({errorAgents.length}명)
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 p-4 pt-2">
            {errorAgents.map((agent) => (
              <div
                key={agent.id}
                onClick={() => onSelectAgent?.(agent.id)}
                className="flex items-center justify-between rounded-lg border border-destructive/20 bg-destructive/5 p-2.5 text-xs cursor-pointer hover:bg-destructive/10"
              >
                <div>
                  <div className="font-semibold text-foreground">{agent.name}</div>
                  <div className="text-muted-foreground">
                    {agent.errorReason || agent.pauseReason || "오류/차단 발생"}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* 5. 최근 업무 산출물 (Work Products Live Feed) */}
      <MobileWorkProductsSection
        distinctIssueIds={distinctIssueIds}
        agentNameByIssueId={agentNameByIssueId}
      />

      {/* 5.5 최근 완료 업무 & JARVIS 최종 보고서 (Completed Issues & Final Reports) */}
      <Card data-testid="mobile-completed-work-card">
        <CardHeader className="p-4 pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
              <CardTitle className="text-sm font-semibold">
                최근 완료 업무 & 최종 보고서 ({completedIssues.length}건)
              </CardTitle>
            </div>
            <a
              href="/issues?status=done"
              className="text-xs font-normal text-primary hover:underline"
            >
              전체 →
            </a>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 p-4 pt-2">
          {completedIssues.length === 0 ? (
            <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
              최근 완료된 업무가 없습니다
            </div>
          ) : (
            completedIssues.slice(0, 5).map((issue) => {
              const assigneeName = issue.assigneeAgentId
                ? agentById.get(issue.assigneeAgentId)?.name ?? "AI 에이전트"
                : "미배정";
              const reportComment = jarvisReportComments?.get(issue.id);

              return (
                <a
                  key={issue.id}
                  href={reportComment ? `/issues/${issue.id}#comment-${reportComment.id}` : `/issues/${issue.id}`}
                  data-testid={`mobile-completed-issue-item-${issue.id}`}
                  className="flex flex-col gap-1 rounded-lg border border-border/70 bg-card p-2.5 text-xs shadow-xs hover:bg-muted/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground truncate">
                      {issue.identifier ? `${issue.identifier} · ` : ""}{issue.title}
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>담당: {assigneeName}</span>
                    <span className="text-primary hover:underline">보고서/산출물 확인 →</span>
                  </div>
                </a>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* 6. 회사 헬스체크 및 빠른 이동 네비게이션 */}
      <Card>
        <CardContent className="flex flex-col gap-2 p-4 text-xs">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
              <span>NEXORA Control Plane 상태: 정상</span>
            </span>
            <span>{agents.length}명 등록됨</span>
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <Button size="sm" variant="outline" asChild className="flex-1">
              <Link to="/mobile/approvals">모바일 승인 콘솔</Link>
            </Button>
            <Button size="sm" variant="outline" asChild className="flex-1">
              <Link to="/mobile/settings">모바일 설정</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 7. 긴급 정지 2단계 확인 AlertDialog */}
      <AlertDialog open={emergencyConfirmOpen} onOpenChange={setEmergencyConfirmOpen}>
        <AlertDialogContent data-testid="mobile-emergency-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>회사 전체를 긴급 정지하시겠습니까?</AlertDialogTitle>
            <AlertDialogDescription>
              스마트폰 원격 제어: 모든 에이전트의 실행이 즉시 중단됩니다. 재개(Resume)는 별도의 승인된 절차가 필요합니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="mobile-emergency-cancel-btn">취소</AlertDialogCancel>
            <AlertDialogAction
              data-testid="mobile-emergency-action-btn"
              onClick={() => emergencyPauseMutation.mutate()}
              disabled={emergencyPauseMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Emergency Stop 실행
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 8. 신속 의사결정 / 승인 검토 Sheet */}
      <Sheet open={selectedApproval !== null} onOpenChange={(open) => { if (!open) setSelectedApproval(null); }}>
        <SheetContent data-testid="mobile-approval-review-sheet">
          <SheetHeader>
            <SheetTitle>원격 의사결정 / 승인 검토</SheetTitle>
            <SheetDescription>
              {selectedApproval?.type ?? "Approval"} — ID: {selectedApproval?.id.slice(0, 8)}
              {selectedApproval?.status === "revision_requested" ? " (수정 요청)" : ""}
            </SheetDescription>
          </SheetHeader>
          {selectedApproval ? (
            <div className="flex flex-col gap-4 p-4 text-xs">
              <div className="rounded-lg border p-3 bg-muted/20 space-y-1">
                <div className="font-semibold text-foreground">요청 정보</div>
                <div className="text-muted-foreground">
                  요청 주체:{" "}
                  {selectedApproval.requestedByAgentId
                    ? agentById.get(selectedApproval.requestedByAgentId)?.name ?? selectedApproval.requestedByAgentId
                    : "시스템/운영자"}
                </div>
                <div className="text-muted-foreground">
                  생성 시각: {new Date(selectedApproval.createdAt).toLocaleString()}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-foreground">결재 사유 / 의견 (선택)</label>
                <input
                  type="text"
                  value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)}
                  placeholder="승인 또는 반려 사유를 입력하세요"
                  className="w-full rounded border border-border bg-background px-3 py-2 text-xs"
                  data-testid="mobile-approval-note-input"
                />
              </div>

              {approveMutation.isError ? (
                <span className="text-destructive" data-testid="mobile-sheet-approve-error">
                  승인 요청 처리 실패: 다시 시도하십시오.
                </span>
              ) : null}
              {rejectMutation.isError ? (
                <span className="text-destructive" data-testid="mobile-sheet-reject-error">
                  반려 요청 처리 실패: 다시 시도하십시오.
                </span>
              ) : null}

              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  disabled={rejectMutation.isPending || approveMutation.isPending}
                  onClick={() => rejectMutation.mutate({ id: selectedApproval.id, note: decisionNote })}
                  data-testid="mobile-sheet-reject-btn"
                >
                  반려 (Reject)
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="flex-1 font-semibold"
                  disabled={approveMutation.isPending || rejectMutation.isPending}
                  onClick={() => approveMutation.mutate({ id: selectedApproval.id, note: decisionNote })}
                  data-testid="mobile-sheet-approve-btn"
                >
                  승인 (Approve)
                </Button>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
