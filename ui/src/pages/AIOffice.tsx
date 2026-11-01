import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueComment } from "@paperclipai/shared";
import { JarvisNeuralCommandInterface } from "@/components/neural/JarvisNeuralCommandInterface";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { approvalsApi } from "@/api/approvals";
import { costsApi } from "@/api/costs";
import { aiOfficeApi } from "@/api/aiOffice";
import { companiesApi } from "@/api/companies";
import { dashboardApi } from "@/api/dashboard";
import { issuesApi } from "@/api/issues";
import { knowledgeApi } from "@/api/knowledge";
import { describeApiError } from "@/api/client";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompanyLiveEvent, useLiveUpdatesConnectionStatus } from "@/context/LiveUpdatesProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { VoiceCommandBar, type VoiceBarState } from "@/components/VoiceCommandBar";
import { AIOfficeEvalLab } from "@/components/AIOfficeEvalLab";
import { AIOfficeIncidentLab } from "@/components/AIOfficeIncidentLab";
import { AIOfficeBackupDrLab } from "@/components/AIOfficeBackupDrLab";
import { AIOfficeDataLifecycleLab } from "@/components/AIOfficeDataLifecycleLab";
import { AIOfficeToolTrustLab } from "@/components/AIOfficeToolTrustLab";
import { AIOfficeSecretsLab } from "@/components/AIOfficeSecretsLab";
import { AIOfficeKnowledgeLab } from "@/components/AIOfficeKnowledgeLab";
import { ControlCenterTabs, useControlCenterTab } from "@/components/ControlCenterTabs";
import { deriveAgentCondition } from "@/components/AIOfficeControlTower";
import { AIOfficeMobileSummary } from "@/components/AIOfficeMobileSummary";
import { AIOfficeJarvisTaskInstruction } from "@/components/AIOfficeJarvisTaskInstruction";
import { AIOfficeCeoControlRail } from "@/components/AIOfficeCeoControlRail";
import { DELEGATION_CHAIN_ISSUE_LIMIT } from "@/components/AIOfficeDelegationChain";
import {
  AIOfficeWorkspaceSheet,
  type AIOfficeWorkspaceTarget,
} from "@/components/AIOfficeWorkspaceSheet";
import { useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import {
  AgentDetailSheet,
  computeSeatState,
  type AgentDetailInfo,
} from "@/components/AIOfficeFloor";
import { TopDownOfficeCanvas } from "@/components/office-2d/TopDownOfficeCanvas";

/**
 * NEXORA Master 1차 확정 부서 Room — fixed set, fixed order. `orgUnitName` is
 * the exact, CEO-confirmed real org_unit name for that room (`null` = no
 * matching org_unit yet). Never auto-expand this list and never fuzzy-match
 * a new org_unit into it — every other real org_unit falls through to the
 * "기타 / 미배정 조직" section below instead.
 */
const DEPARTMENT_ROOMS: ReadonlyArray<{ label: string; orgUnitName: string | null }> = [
  { label: "비서실", orgUnitName: "비서실" },
  { label: "개발팀", orgUnitName: "개발팀" },
  { label: "기획·전략팀", orgUnitName: "기획·전략팀" },
  { label: "QA팀", orgUnitName: "QA·품질팀" },
  { label: "영업팀", orgUnitName: null },
  { label: "회계·재무팀", orgUnitName: "재무·관리팀" },
  { label: "법무팀", orgUnitName: null },
  { label: "교육팀", orgUnitName: null },
];

const SECRETARIAT_ROOM = DEPARTMENT_ROOMS[0]!;

/**
 * Distinguishes "the query hasn't resolved / failed" from "it resolved and
 * genuinely returned nothing" — collapsing both into `data ?? []` is exactly
 * what made a live fetch failure look identical to legitimate empty data.
 * `error`/`loading` must never be reported as `empty` (which the UI renders
 * as "미연결/공석/배정 대기") or vice versa.
 */
type QueryState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "empty" } | { kind: "data" };

function describeQueryState<T>(query: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  data: T[] | undefined;
}): QueryState {
  if (query.isLoading) return { kind: "loading" };
  if (query.isError) {
    return { kind: "error", message: describeApiError(query.error, "알 수 없는 오류") };
  }
  if (!query.data || query.data.length === 0) return { kind: "empty" };
  return { kind: "data" };
}

function StatValue({ state, value }: { state: QueryState; value: number }) {
  if (state.kind === "loading") return <span className="text-lg font-semibold text-muted-foreground">…</span>;
  if (state.kind === "error") return <span className="text-lg font-semibold text-destructive">오류</span>;
  return <span className="text-lg font-semibold">{value}</span>;
}

export type AIOfficeViewMode = "floor" | "summary" | "neural";

function resolveViewModeFromLocation(defaultMode: AIOfficeViewMode): AIOfficeViewMode {
  if (typeof window !== "undefined" && window.location) {
    const sp = new URLSearchParams(window.location.search);
    const view = sp.get("view");
    if (view === "neural") return "neural";
    if (view === "summary") return "summary";
    if (view === "floor") return "floor";
  }
  return defaultMode;
}

export function useAIOfficeViewMode(
  defaultMode: AIOfficeViewMode = "floor",
): [AIOfficeViewMode, (mode: AIOfficeViewMode) => void] {
  const [mode, setModeState] = useState<AIOfficeViewMode>(() =>
    resolveViewModeFromLocation(defaultMode),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handlePopState = () => {
      setModeState(resolveViewModeFromLocation(defaultMode));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [defaultMode]);

  const setMode = useCallback((newMode: AIOfficeViewMode) => {
    setModeState(newMode);
    if (typeof window !== "undefined" && window.history) {
      const url = new URL(window.location.href);
      if (newMode === "neural") {
        url.searchParams.set("view", "neural");
      } else if (newMode === "summary") {
        url.searchParams.set("view", "summary");
      } else {
        url.searchParams.delete("view");
      }
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  return [mode, setMode];
}

export function AIOffice() {
  const { selectedCompanyId } = useCompany();
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [emergencyStopConfirmOpen, setEmergencyStopConfirmOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState<AIOfficeWorkspaceTarget | null>(null);
  const handledFocusRef = useRef<string | null>(null);
  const [controlCenterTab, setControlCenterTab] = useControlCenterTab("sre");
  const [viewMode, setViewMode] = useAIOfficeViewMode("floor");
  const [voiceState, setVoiceState] = useState<VoiceBarState>("idle");
  const isConnected = useLiveUpdatesConnectionStatus();

  // heartbeat.run.progress is already handled globally by LiveUpdatesProvider
  // (invalidateHeartbeatProgressQueries + event-sourced liveRuns patching) —
  // only plugin.ui.updated has no provider-side coverage.
  useCompanyLiveEvent(
    useCallback(
      (event: any) => {
        const eventType =
          typeof event === "string"
            ? event
            : event?.type ?? event?.event;

        if (eventType === "plugin.ui.updated") {
          queryClient.invalidateQueries({
            queryKey: queryKeys.instance.aiOfficeStatus,
          });
        }
      },
      [queryClient],
    ),
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "AI Office" }]);
  }, [setBreadcrumbs]);

  const isSummaryView = viewMode === "summary";
  const isFloorView = viewMode === "floor";
  const isNeuralView = viewMode === "neural";

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: isConnected ? false : 60_000,
  });

  const liveRunsQuery = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: isConnected ? false : 60_000,
  });

  const pendingApprovalsQuery = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: isConnected ? false : 60_000,
  });

  const revisionRequestedApprovalsQuery = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "revision_requested"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "revision_requested"),
    enabled: !!selectedCompanyId,
    refetchInterval: isConnected ? false : 60_000,
  });

  const inReviewIssuesQuery = useQuery({
    queryKey: queryKeys.issues.listByStatus(selectedCompanyId!, { status: "in_review" }),
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: "in_review" }),
    enabled: !!selectedCompanyId,
    refetchInterval: isConnected ? false : 60_000,
  });

  const completedIssuesQuery = useQuery({
    queryKey: queryKeys.issues.listByStatus(selectedCompanyId!, {
      status: "done",
      sortField: "updated",
      sortDir: "desc",
    }),
    queryFn: () => issuesApi.list(selectedCompanyId!, {
      status: "done",
      sortField: "updated",
      sortDir: "desc",
    }),
    enabled: !!selectedCompanyId && !isNeuralView,
    refetchInterval: isConnected ? false : 60_000,
  });

  const allIssuesQuery = useQuery({
    queryKey: queryKeys.issues.listDelegationChain(selectedCompanyId!, DELEGATION_CHAIN_ISSUE_LIMIT),
    queryFn: async () => {
      if (typeof issuesApi?.list !== "function") return [];
      const res = await issuesApi.list(selectedCompanyId!, {
        limit: DELEGATION_CHAIN_ISSUE_LIMIT,
      });
      return Array.isArray(res) ? res : [];
    },
    enabled: !!selectedCompanyId && !isNeuralView,
    refetchInterval: isConnected ? false : 60_000,
  });

  const orgUnitsQuery = useQuery({
    queryKey: queryKeys.agents.orgUnitsStatus(selectedCompanyId!),
    queryFn: () => agentsApi.orgUnitsStatus(selectedCompanyId!),
    enabled: !!selectedCompanyId && !isSummaryView,
    refetchInterval: isConnected ? false : 60_000,
  });

  // No realtime event backs instance-wide AI Office status — keeps polling
  // unconditionally, independent of socket connection state.
  const statusQuery = useQuery({
    queryKey: queryKeys.instance.aiOfficeStatus,
    queryFn: aiOfficeApi.getStatus,
    enabled: isFloorView,
    refetchInterval: 15_000,
  });

  const costByAgentModelQuery = useQuery({
    queryKey: queryKeys.costByAgentModel(selectedCompanyId!),
    queryFn: () => costsApi.byAgentModel(selectedCompanyId!),
    enabled: !!selectedCompanyId && (!isNeuralView || Boolean(selectedAgentId)),
    refetchInterval: isConnected ? false : 60_000,
  });

  const costByProviderQuery = useQuery({
    queryKey: queryKeys.usageByProvider(selectedCompanyId!),
    queryFn: () => costsApi.byProvider(selectedCompanyId!),
    enabled: !!selectedCompanyId && isFloorView,
    refetchInterval: isConnected ? false : 60_000,
  });

  // usageQuotaWindows is intentionally excluded from realtime invalidation
  // (external provider poll, unrelated to internal events) — keeps its own
  // independent timer regardless of socket connection state.
  const quotaWindowsQuery = useQuery({
    queryKey: queryKeys.usageQuotaWindows(selectedCompanyId!),
    queryFn: () => costsApi.quotaWindows(selectedCompanyId!),
    enabled: !!selectedCompanyId && isFloorView,
    refetchInterval: 30_000,
  });

  const dashboardQuery = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId && !isFloorView,
    refetchInterval: isConnected ? false : 60_000,
  });

  const knowledgeQuery = useQuery({
    queryKey: queryKeys.knowledge.list(selectedCompanyId!, 500),
    queryFn: () => knowledgeApi.listKnowledgeRecords(selectedCompanyId!, { limit: 500 }),
    enabled: !!selectedCompanyId && isNeuralView,
    refetchInterval: isConnected ? false : 60_000,
  });

  const emergencyPauseMutation = useMutation({
    mutationFn: () => companiesApi.emergencyPause(selectedCompanyId!),
    onSuccess: () => setEmergencyStopConfirmOpen(false),
  });

  const agentsState = describeQueryState(agentsQuery);
  const orgUnitsState = describeQueryState(orgUnitsQuery);
  const liveRunsState = describeQueryState(liveRunsQuery);

  const agents = agentsQuery.data ?? [];
  const liveRunByAgentId = new Map((liveRunsQuery.data ?? []).map((run) => [run.agentId, run]));
  const allPendingApprovals = [
    ...(pendingApprovalsQuery.data ?? []),
    ...(revisionRequestedApprovalsQuery.data ?? []),
  ];
  const pendingApprovalsCombined = {
    isLoading: pendingApprovalsQuery.isLoading || revisionRequestedApprovalsQuery.isLoading,
    isError: pendingApprovalsQuery.isError || revisionRequestedApprovalsQuery.isError,
    error: pendingApprovalsQuery.error ?? revisionRequestedApprovalsQuery.error,
    data: allPendingApprovals,
  };
  const pendingApprovalsState = describeQueryState(pendingApprovalsCombined);
  const inReviewIssuesState = describeQueryState(inReviewIssuesQuery);
  const completedIssuesState = describeQueryState(completedIssuesQuery);
  const allIssuesState = describeQueryState(allIssuesQuery);

  // The office floor (leadership + department rooms + 기타/미배정) needs both
  // agents and org units to be genuinely resolved before it can tell "no
  // data" apart from "still loading" or "the fetch failed" — loading/error
  // must never fall through to a room silently rendering as 미연결/공석.
  const officeSectionState: "loading" | "error" | "empty" | "ready" =
    agentsState.kind === "loading" || orgUnitsState.kind === "loading"
      ? "loading"
      : agentsState.kind === "error" || orgUnitsState.kind === "error"
        ? "error"
        : agentsState.kind === "empty"
          ? "empty"
          : "ready";

  const pendingApprovalAgentIds = new Set(
    allPendingApprovals
      .filter((approval) => !!approval.requestedByAgentId)
      .map((approval) => approval.requestedByAgentId as string),
  );
  const inReviewAgentIds = new Set(
    (inReviewIssuesQuery.data ?? [])
      .filter((issue) => !!issue.assigneeAgentId)
      .map((issue) => issue.assigneeAgentId as string),
  );
  const orgUnitIdByName = new Map((orgUnitsQuery.data ?? []).map((unit) => [unit.name, unit.orgUnitId]));
  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const now = Date.now();

  // Exact-name lookups only — never a fuzzy/partial match on leadership seats.
  const jarvis = agents.find((agent) => agent.name === "JARVIS");
  const atlas = agents.find((agent) => agent.name === "Atlas");

  const delegatedParentIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const issue of allIssuesQuery.data ?? []) {
      if (issue.parentId) {
        ids.add(issue.parentId);
      }
    }
    return ids;
  }, [allIssuesQuery.data]);

  // N+1 Optimization: candidate pre-filtering for root/orchestrator parent issues (JARVIS, Atlas, or delegated parents)
  const jarvisReportCandidates = useMemo(() => {
    if (isNeuralView) return [];
    if (!jarvis && !atlas && delegatedParentIssueIds.size === 0) return [];
    const inReview = inReviewIssuesQuery.data ?? [];
    const completed = (completedIssuesQuery.data ?? []).slice(0, 10);
    const delegatedFromAll = (allIssuesQuery.data ?? []).filter(
      (issue) =>
        (issue.status === "in_review" || issue.status === "done") &&
        delegatedParentIssueIds.has(issue.id),
    );
    const combined = [...inReview, ...completed, ...delegatedFromAll];
    const seen = new Set<string>();
    return combined.filter((issue) => {
      const isRootJarvis = issue.parentId === null && Boolean(jarvis && issue.assigneeAgentId === jarvis.id);
      const isRootAtlas = issue.parentId === null && Boolean(atlas && issue.assigneeAgentId === atlas.id);
      const isRootDelegatedParent = issue.parentId === null && delegatedParentIssueIds.has(issue.id);
      const isAtlasDelegatedParent =
        Boolean(atlas && issue.assigneeAgentId === atlas.id) && delegatedParentIssueIds.has(issue.id);

      if (!isRootJarvis && !isRootAtlas && !isRootDelegatedParent && !isAtlasDelegatedParent) {
        return false;
      }
      if (seen.has(issue.id)) return false;
      seen.add(issue.id);
      return true;
    });
  }, [isNeuralView, inReviewIssuesQuery.data, completedIssuesQuery.data, allIssuesQuery.data, jarvis, atlas, delegatedParentIssueIds]);

  const jarvisReportCommentQueries = useQueries({
    queries: jarvisReportCandidates.map((issue) => ({
      queryKey: queryKeys.issues.reportComments(issue.id, { order: "desc", limit: 10 }),
      queryFn: () => issuesApi.listComments(issue.id, { order: "desc", limit: 10 }),
      enabled: !isNeuralView && Boolean(issue.id),
      staleTime: 15_000,
      retry: false,
    })),
  });

  // Source of Truth: canonical JARVIS parent report OR verified JARVIS/Atlas completion/synthesis report comment (never issue.description)
  const jarvisReportCommentByIssueId = useMemo(() => {
    const map = new Map<string, IssueComment>();
    const orchestratorIds = new Set<string>();
    if (jarvis?.id) orchestratorIds.add(jarvis.id);
    if (atlas?.id) orchestratorIds.add(atlas.id);

    jarvisReportCommentQueries.forEach((q, idx) => {
      const candidate = jarvisReportCandidates[idx];
      if (!candidate || !q.data || !Array.isArray(q.data)) return;

      const canonicalComment = q.data.find(
        (comment) =>
          Boolean(comment.body?.trim()) &&
          (comment.metadata?.authorizationReason === "canonical_jarvis_parent_report" ||
            (comment.metadata?.sections as Array<{ title?: string | null }> | undefined)?.some(
              (section) =>
                typeof section?.title === "string" &&
                /jarvis parent report|atlas.*report|최종\s*보고|통합\s*보고|완료\s*보고/i.test(
                  section.title,
                ),
            )),
      );
      if (canonicalComment) {
        map.set(candidate.id, canonicalComment);
        return;
      }

      const verifiedOrchestratorReport = q.data.find((comment) => {
        const body = comment.body?.trim() ?? "";
        if (!body) return false;
        if (candidate.description?.trim() && body === candidate.description.trim()) {
          return false;
        }
        const isOrchestratorAuthor =
          (comment.authorAgentId && orchestratorIds.has(comment.authorAgentId)) ||
          (candidate.assigneeAgentId &&
            comment.authorAgentId === candidate.assigneeAgentId &&
            orchestratorIds.has(candidate.assigneeAgentId));
        if (!isOrchestratorAuthor) return false;

        return /(?:최종\s*보고|통합\s*보고|완료\s*보고|결과\s*보고|종합\s*보고|작업\s*완료|업무\s*완료|산출물|검증\s*결과|이행\s*결과|final\s*report|completion\s*report|synthesis\s*report)/i.test(
          body,
        );
      });

      if (verifiedOrchestratorReport) {
        map.set(candidate.id, verifiedOrchestratorReport);
      }
    });
    return map;
  }, [jarvisReportCommentQueries, jarvisReportCandidates, jarvis, atlas]);

  const mobileConnectionErrorMessage = useMemo(() => {
    const errors: string[] = [];
    if (agentsState.kind === "error") errors.push(`AI 직원: ${agentsState.message}`);
    if (liveRunsState.kind === "error") errors.push(`실시간 실행: ${liveRunsState.message}`);
    if (pendingApprovalsState.kind === "error") errors.push(`승인 대기: ${pendingApprovalsState.message}`);
    if (inReviewIssuesState.kind === "error") errors.push(`검토 대기: ${inReviewIssuesState.message}`);
    if (allIssuesState.kind === "error") errors.push(`업무 목록: ${allIssuesState.message}`);
    return errors.length > 0 ? errors.join(" · ") : null;
  }, [agentsState, liveRunsState, pendingApprovalsState, inReviewIssuesState, allIssuesState]);

  const isMobileCoreLoading =
    agentsQuery.isLoading ||
    liveRunsQuery.isLoading ||
    pendingApprovalsCombined.isLoading ||
    inReviewIssuesQuery.isLoading ||
    Boolean(allIssuesQuery.isLoading);

  const handleMobileRefresh = useCallback(() => {
    void agentsQuery.refetch();
    void liveRunsQuery.refetch();
    void pendingApprovalsQuery.refetch();
    void revisionRequestedApprovalsQuery.refetch();
    void inReviewIssuesQuery.refetch();
    void completedIssuesQuery.refetch();
    void allIssuesQuery.refetch();
    void dashboardQuery.refetch();
  }, [
    agentsQuery,
    liveRunsQuery,
    pendingApprovalsQuery,
    revisionRequestedApprovalsQuery,
    inReviewIssuesQuery,
    completedIssuesQuery,
    allIssuesQuery,
    dashboardQuery,
  ]);

  const mappedOrgUnitNames = new Set(
    DEPARTMENT_ROOMS.map((room) => room.orgUnitName).filter((name): name is string => !!name),
  );
  const otherOrgUnits = (orgUnitsQuery.data ?? []).filter((unit) => !mappedOrgUnitNames.has(unit.name));

  const blockedOrOfflineAgents = agents
    .map((agent) => ({
      agent,
      condition: deriveAgentCondition(agent, liveRunByAgentId.has(agent.id), now),
    }))
    .filter((entry): entry is { agent: (typeof agents)[number]; condition: "error" | "offline" } => entry.condition !== null);

  const errorAgents = blockedOrOfflineAgents.filter((entry) => entry.condition === "error");
  const offlineAgents = blockedOrOfflineAgents.filter((entry) => entry.condition === "offline");

  const usageByAgent = new Map<string, { agentName: string; costCents: number }>();
  for (const row of costByAgentModelQuery.data ?? []) {
    const existing = usageByAgent.get(row.agentId);
    usageByAgent.set(row.agentId, {
      agentName: row.agentName ?? row.agentId,
      costCents: (existing?.costCents ?? 0) + row.costCents,
    });
  }
  const topUsageAgents = [...usageByAgent.entries()]
    .sort((a, b) => b[1].costCents - a[1].costCents)
    .slice(0, 5);

  // Workstation click opens the detail Sheet using only data already in
  // memory (agents/liveRunByAgentId/pendingApprovalAgentIds) — never a new
  // request.
  function agentDetailFor(agent: (typeof agents)[number]): AgentDetailInfo {
    const liveRun = liveRunByAgentId.get(agent.id);
    const hasPendingApproval = pendingApprovalAgentIds.has(agent.id);
    const hasInReview = inReviewAgentIds.has(agent.id);
    const state = computeSeatState(agent, !!liveRun, hasPendingApproval, now, hasInReview);
    const agentUsage = usageByAgent.get(agent.id);
    const costModelRow = (costByAgentModelQuery.data ?? []).find((r) => r.agentId === agent.id);
    const adapterConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const configuredModel = typeof adapterConfig.model === "string" && adapterConfig.model.trim() ? adapterConfig.model : null;

    const selectedExecutor = agent.adapterType ?? null;
    const actualExecutor = liveRun?.adapterType ?? null;
    const provider = costModelRow?.provider ?? null;
    const model = configuredModel ?? costModelRow?.model ?? null;

    const inReviewIssue = (inReviewIssuesQuery.data ?? []).find(
      (issue) => issue.assigneeAgentId === agent.id,
    );
    const currentIssueId = liveRun?.issueId ?? inReviewIssue?.id ?? null;
    const currentIssueIdentifier = inReviewIssue?.identifier ?? null;
    const currentIssueTitle = inReviewIssue?.title ?? null;
    const taskSummary = liveRun
      ? (liveRun.currentStatusMessage ?? liveRun.triggerDetail ?? liveRun.lastAssistantSnippet ?? null)
      : inReviewIssue
        ? `[검토 대기] ${inReviewIssue.title}`
        : null;

    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.title ?? agent.role,
      state,
      taskSummary,
      selectedExecutor,
      actualExecutor,
      provider,
      model,
      currentToolName: liveRun?.currentToolName ?? null,
      activeRunId: liveRun?.id ?? null,
      aggregateCostCents: agentUsage?.costCents ?? (agent.spentMonthlyCents > 0 ? agent.spentMonthlyCents : null),
      currentRunCostCents: null,
      currentIssueId,
      currentIssueIdentifier,
      currentIssueTitle,
      errorReason: agent.errorReason ?? null,
      pauseReason: agent.pauseReason ?? null,
    };
  }

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedAgentDetail = selectedAgent ? agentDetailFor(selectedAgent) : null;

  useEffect(() => {
    const focus = new URLSearchParams(location.search).get("focus");
    if (!focus) {
      handledFocusRef.current = null;
      return;
    }
    if (handledFocusRef.current === focus) return;
    const focusAgent = focus === "jarvis" ? jarvis : focus === "atlas" ? atlas : null;
    if (!focusAgent) return;
    handledFocusRef.current = focus;
    if (viewMode !== "floor") setViewMode("floor");
    setSelectedWorkspace(null);
    setSelectedAgentId(focusAgent.id);
  }, [location.search, jarvis, atlas, viewMode, setViewMode]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">AI Office</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          NEXORA가 확정한 조직 구조를 기준 화면으로 사용합니다. 실제 DB에 연결된 직원만 실시간
          상태가 표시되며, 아직 연결되지 않은 자리는 명확히 &ldquo;미연결/공석/배정 대기&rdquo;로
          표시됩니다.
        </p>
      </div>

      {/* 상단 요약 바 — 회사 전체 현황 요약 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card>
          <CardContent className="flex flex-col gap-1 p-3 text-sm">
            <span className="text-xs text-muted-foreground">전체 인원</span>
            <StatValue state={agentsState} value={agents.length} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1 p-3 text-sm">
            <span className="text-xs text-muted-foreground">업무 중</span>
            <StatValue state={liveRunsState} value={liveRunByAgentId.size} />
          </CardContent>
        </Card>
        <Card data-testid="desktop-in-review-metric">
          <CardContent className="flex flex-col gap-1 p-3 text-sm">
            <span className="text-xs text-muted-foreground">검토 대기</span>
            <StatValue state={inReviewIssuesState} value={(inReviewIssuesQuery.data ?? []).length} />
          </CardContent>
        </Card>
        <Card data-testid="desktop-pending-approvals-metric">
          <CardContent className="flex flex-col gap-1 p-3 text-sm">
            <span className="text-xs text-muted-foreground">승인 대기</span>
            <StatValue state={pendingApprovalsState} value={allPendingApprovals.length} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1 p-3 text-sm">
            <span className="text-xs text-muted-foreground">오류/차단</span>
            <StatValue state={agentsState} value={errorAgents.length} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1 p-3 text-sm">
            <span className="text-xs text-muted-foreground">오프라인</span>
            <StatValue state={agentsState} value={offlineAgents.length} />
          </CardContent>
        </Card>
      </div>

      {/* 뷰 모드 전환 셀렉터 (2D 오피스 | 모바일 요약 | JARVIS 뉴럴 맵) */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 text-xs">
          <Button
            type="button"
            variant={viewMode === "floor" ? "default" : "ghost"}
            size="sm"
            className="h-8 text-xs font-semibold"
            onClick={() => setViewMode("floor")}
            data-testid="view-mode-floor-btn"
            aria-pressed={viewMode === "floor"}
          >
            2D 오피스
          </Button>
          <Button
            type="button"
            variant={viewMode === "summary" ? "default" : "ghost"}
            size="sm"
            className="h-8 text-xs font-semibold"
            onClick={() => setViewMode("summary")}
            data-testid="view-mode-summary-btn"
            aria-pressed={viewMode === "summary"}
          >
            모바일 요약
          </Button>
          <Button
            type="button"
            variant={viewMode === "neural" ? "default" : "ghost"}
            size="sm"
            className="h-8 text-xs font-semibold"
            onClick={() => setViewMode("neural")}
            data-testid="view-mode-neural-btn"
            aria-pressed={viewMode === "neural"}
          >
            JARVIS 뉴럴 맵
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          {viewMode === "floor"
            ? "실제 좌석 및 부서 배치 평면도"
            : viewMode === "summary"
              ? "경영진 모바일 종합 관제 및 핵심 현황"
              : "JARVIS 지휘 신경망 및 지능형 라우팅 관측"}
        </span>
      </div>

      {viewMode === "neural" ? (
        <JarvisNeuralCommandInterface
          agents={agents}
          orgUnits={orgUnitsQuery.data ?? []}
          liveRuns={liveRunsQuery.data ?? []}
          pendingApprovals={allPendingApprovals}
          completedCount={dashboardQuery.isLoading ? null : (dashboardQuery.data?.tasks.done ?? null)}
          blockedCount={dashboardQuery.isLoading ? null : (dashboardQuery.data?.tasks.blocked ?? null)}
          pendingApprovalCount={
            pendingApprovalsQuery.isLoading || revisionRequestedApprovalsQuery.isLoading
              ? null
              : allPendingApprovals.filter(
                  (a) =>
                    (a as { effectiveStatus?: string }).effectiveStatus === "pending" ||
                    a.status === "pending" ||
                    a.status === "revision_requested",
                ).length
          }
          knowledgeRecords={knowledgeQuery.data ?? []}
          voiceState={voiceState}
          onNavigateToKnowledgeTab={() => setControlCenterTab("knowledge")}
          isLoading={agentsQuery.isLoading || orgUnitsQuery.isLoading}
          error={agentsQuery.error || orgUnitsQuery.error}
          companyId={selectedCompanyId}
        />
      ) : viewMode === "summary" ? (
        <AIOfficeMobileSummary
          companyId={selectedCompanyId}
          agents={agents}
          liveRuns={liveRunsQuery.data ?? []}
          pendingApprovals={allPendingApprovals}
          errorAgents={errorAgents.map((e) => e.agent)}
          dashboardData={dashboardQuery.data ?? null}
          costByAgentModel={costByAgentModelQuery.data ?? []}
          onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
          inReviewIssues={inReviewIssuesQuery.data ?? []}
          completedIssues={completedIssuesQuery.data ?? []}
          allIssues={allIssuesQuery.data}
          isIssuesLoading={allIssuesQuery.isLoading}
          issuesErrorMessage={allIssuesState.kind === "error" ? allIssuesState.message : null}
          isCoreLoading={isMobileCoreLoading}
          connectionErrorMessage={mobileConnectionErrorMessage}
          onRetryConnection={handleMobileRefresh}
          jarvisReportComments={jarvisReportCommentByIssueId}
        />
      ) : (
        /* 중앙 2D 사무실 + 우측 운영 패널 */
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div className="space-y-4 lg:col-span-3">
          {/* Desktop JARVIS Text Instruction */}
          <AIOfficeJarvisTaskInstruction
            companyId={selectedCompanyId}
            jarvisAgent={jarvis ?? null}
            agentById={agentById}
          />

          {officeSectionState === "loading" ? (
            <div className="rounded-lg border p-6 text-sm text-muted-foreground">조직 데이터 로딩 중...</div>
          ) : officeSectionState === "error" ? (
            <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              {agentsState.kind === "error" ? <div>에이전트 데이터 조회 실패: {agentsState.message}</div> : null}
              {orgUnitsState.kind === "error" ? <div>조직 데이터 조회 실패: {orgUnitsState.message}</div> : null}
            </div>
          ) : officeSectionState === "empty" ? (
            <div className="rounded-lg border p-6 text-sm text-muted-foreground">
              {agentsState.kind === "empty" ? "에이전트 데이터 없음" : "조직 데이터 없음"}
            </div>
          ) : (
            <TopDownOfficeCanvas
              agents={agents}
              orgUnits={orgUnitsQuery.data ?? []}
              departmentRooms={DEPARTMENT_ROOMS}
              secretariatRoom={SECRETARIAT_ROOM}
              otherOrgUnits={otherOrgUnits}
              jarvis={jarvis}
              atlas={atlas}
              liveRunByAgentId={liveRunByAgentId}
              pendingApprovalAgentIds={pendingApprovalAgentIds}
              inReviewAgentIds={inReviewAgentIds}
              orgUnitIdByName={orgUnitIdByName}
              allIssues={allIssuesQuery.data}
              completedIssues={completedIssuesQuery.data}
              pendingApprovalCount={allPendingApprovals.length}
              voiceState={voiceState}
              now={now}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
              onSelectWorkspace={(target) => setSelectedWorkspace(target)}
            />
          )}
        </div>

        {/* 우측 CEO Control Rail */}
        <AIOfficeCeoControlRail
          companyId={selectedCompanyId ?? ""}
          allPendingApprovals={allPendingApprovals}
          isApprovalsLoading={pendingApprovalsCombined.isLoading}
          approvalsErrorMessage={pendingApprovalsState.kind === "error" ? pendingApprovalsState.message : null}
          inReviewIssues={inReviewIssuesQuery.data ?? []}
          isInReviewLoading={inReviewIssuesQuery.isLoading}
          inReviewErrorMessage={inReviewIssuesState.kind === "error" ? inReviewIssuesState.message : null}
          completedIssues={completedIssuesQuery.data ?? []}
          isCompletedLoading={completedIssuesQuery.isLoading}
          completedErrorMessage={completedIssuesState.kind === "error" ? completedIssuesState.message : null}
          blockedOrOfflineAgents={blockedOrOfflineAgents}
          isAgentsLoading={agentsState.kind === "loading" || liveRunsState.kind === "loading"}
          agentsErrorMessage={agentsState.kind === "error" ? agentsState.message : null}
          agents={agents}
          allIssues={allIssuesQuery.data}
          isIssuesLoading={allIssuesQuery.isLoading}
          issuesErrorMessage={allIssuesState.kind === "error" ? allIssuesState.message : null}
          liveRuns={liveRunsQuery.data ?? []}
          jarvisReportCommentByIssueId={jarvisReportCommentByIssueId}
          onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
        />
      </div>
      )}

      {/* Control Center IA Grouped Tabs */}
      <ControlCenterTabs
        activeTab={controlCenterTab}
        onTabChange={setControlCenterTab}
      />

      {/* Tab Panel: SRE (F-06, F-03) */}
      {(controlCenterTab === "sre" || controlCenterTab === "all") && (
        <section
          role="tabpanel"
          id="control-center-panel-sre"
          aria-labelledby="control-center-tab-sre"
          data-testid="control-center-panel-sre"
          className="space-y-4"
        >
          {/* F-06 Incident & SRE Control Center */}
          <AIOfficeIncidentLab />

          {/* F-03 Backup & Disaster Recovery Control Center */}
          <AIOfficeBackupDrLab />
        </section>
      )}

      {/* Tab Panel: Security & Trust (F-05, F-02) */}
      {(controlCenterTab === "security" || controlCenterTab === "all") && (
        <section
          role="tabpanel"
          id="control-center-panel-security"
          aria-labelledby="control-center-tab-security"
          data-testid="control-center-panel-security"
          className="space-y-4"
        >
          {/* F-05 Tool / Plugin Trust Registry Control Center */}
          <AIOfficeToolTrustLab />

          {/* F-02 Secrets / Credential Management Control Center */}
          {selectedCompanyId ? <AIOfficeSecretsLab key={selectedCompanyId} companyId={selectedCompanyId} /> : null}
        </section>
      )}

      {/* Tab Panel: Knowledge & Data (F-07/F-08, F-01) */}
      {(controlCenterTab === "knowledge" || controlCenterTab === "all") && (
        <section
          role="tabpanel"
          id="control-center-panel-knowledge"
          aria-labelledby="control-center-tab-knowledge"
          data-testid="control-center-panel-knowledge"
          className="space-y-4"
        >
          {/* F-07/F-08 Knowledge & Memory Operations Control Center */}
          <AIOfficeKnowledgeLab companyId={selectedCompanyId ?? undefined} />

          {/* F-01 Data Lifecycle & Governance Control Center */}
          <AIOfficeDataLifecycleLab />
        </section>
      )}

      {/* Tab Panel: Quality & Evaluation (F-04) */}
      {(controlCenterTab === "quality" || controlCenterTab === "all") && (
        <section
          role="tabpanel"
          id="control-center-panel-quality"
          aria-labelledby="control-center-tab-quality"
          data-testid="control-center-panel-quality"
          className="space-y-4"
        >
          {/* F-04 Agent Quality & Simulation Lab (Control Center) */}
          <AIOfficeEvalLab agentNameById={agentNameById} />
        </section>
      )}

      {/* 하단 운영 패널 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">사용량/한도</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs">
            {(quotaWindowsQuery.data ?? []).length === 0 ? (
              <span className="text-muted-foreground">데이터 없음</span>
            ) : (
              (quotaWindowsQuery.data ?? []).map((result) => (
                <div key={result.provider} className="flex justify-between gap-2">
                  <span className="font-medium">{result.provider}</span>
                  <span className="text-muted-foreground">
                    {result.ok ? `${result.windows.length}개 윈도우` : result.error ?? "조회 실패"}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">비용 현황</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs">
            {(costByProviderQuery.data ?? []).length === 0 ? (
              <span className="text-muted-foreground">데이터 없음</span>
            ) : (
              (costByProviderQuery.data ?? []).map((row, index) => (
                <div key={`${row.provider}-${row.model}-${index}`} className="flex justify-between gap-2">
                  <span className="truncate font-medium">
                    {row.provider} / {row.model}
                  </span>
                  <span className="text-muted-foreground">${(row.costCents / 100).toFixed(2)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">사용량 TOP</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs">
            {topUsageAgents.length === 0 ? (
              <span className="text-muted-foreground">데이터 없음</span>
            ) : (
              topUsageAgents.map(([agentId, entry]) => (
                <div key={agentId} className="flex justify-between gap-2">
                  <span className="truncate font-medium">{entry.agentName}</span>
                  <span className="text-muted-foreground">${(entry.costCents / 100).toFixed(2)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Model Router 성과</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">연동 예정 — 아직 UI 데이터 없음</CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">시스템 상태</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs">
            {statusQuery.data ? (
              <>
                <div className="flex justify-between gap-2">
                  <span>Supervisor</span>
                  <span className="text-muted-foreground">{statusQuery.data.supervisor.status}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Database</span>
                  <span className="text-muted-foreground">{statusQuery.data.database.status}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Server</span>
                  <span className="text-muted-foreground">{statusQuery.data.server.status}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>Backup</span>
                  <span className="text-muted-foreground">{statusQuery.data.backup.status}</span>
                </div>
              </>
            ) : (
              <span className="text-muted-foreground">로딩 중...</span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Emergency Stop</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={!selectedCompanyId || emergencyPauseMutation.isPending}
              onClick={() => setEmergencyStopConfirmOpen(true)}
            >
              Emergency Stop
            </Button>
            {emergencyPauseMutation.isError ? (
              <span className="text-xs text-destructive">긴급 정지 요청이 실패했습니다.</span>
            ) : null}
            {emergencyPauseMutation.isSuccess ? (
              <span className="text-xs text-muted-foreground">회사가 긴급 정지되었습니다.</span>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={emergencyStopConfirmOpen} onOpenChange={setEmergencyStopConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>회사 전체를 긴급 정지하시겠습니까?</AlertDialogTitle>
            <AlertDialogDescription>
              모든 에이전트의 실행이 즉시 중단됩니다. 재개(Resume)는 별도의 승인된 절차가 필요하며 이
              화면에서는 지원하지 않습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => emergencyPauseMutation.mutate()}
              disabled={emergencyPauseMutation.isPending}
            >
              Emergency Stop 실행
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AgentDetailSheet agent={selectedAgentDetail} onOpenChange={(open) => { if (!open) setSelectedAgentId(null); }} />

      <AIOfficeWorkspaceSheet
        target={selectedWorkspace}
        agents={agents}
        issues={allIssuesQuery.data ?? [...(inReviewIssuesQuery.data ?? []), ...(completedIssuesQuery.data ?? [])]}
        approvals={allPendingApprovals}
        onOpenChange={(open) => { if (!open) setSelectedWorkspace(null); }}
        onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
      />

      {/* Voice 진입 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Voice / JARVIS 음성 명령</CardTitle>
        </CardHeader>
        <CardContent>
          {selectedCompanyId ? (
            <VoiceCommandBar companyId={selectedCompanyId} onStateChange={setVoiceState} />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
