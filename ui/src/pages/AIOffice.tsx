import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Building2, Coffee, DoorOpen, ShieldAlert, Sofa, Sprout, Users } from "lucide-react";
import { JarvisNeuralCommandInterface } from "@/components/neural/JarvisNeuralCommandInterface";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { approvalsApi } from "@/api/approvals";
import { costsApi } from "@/api/costs";
import { aiOfficeApi } from "@/api/aiOffice";
import { companiesApi } from "@/api/companies";
import { dashboardApi } from "@/api/dashboard";
import { knowledgeApi } from "@/api/knowledge";
import { describeApiError } from "@/api/client";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
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
import { DecisionQueueRail } from "@/components/DecisionQueueRail";
import { ActivityFeed } from "@/components/ActivityFeed";
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
import {
  AgentDetailSheet,
  AmenityTile,
  computeSeatState,
  EmptyRoomNote,
  EmptySeat,
  RoomBox,
  SeatBadge,
  Workstation,
  type AgentDetailInfo,
} from "@/components/AIOfficeFloor";

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

function StateNotice({ state, loadingText, emptyText, errorPrefix }: {
  state: QueryState;
  loadingText: string;
  emptyText: string;
  errorPrefix: string;
}) {
  if (state.kind === "loading") {
    return <span className="text-muted-foreground">{loadingText}</span>;
  }
  if (state.kind === "error") {
    return (
      <span className="text-destructive">
        {errorPrefix}: {state.message}
      </span>
    );
  }
  return <span className="text-muted-foreground">{emptyText}</span>;
}

export type AIOfficeViewMode = "floor" | "neural";

export function useAIOfficeViewMode(
  defaultMode: AIOfficeViewMode = "floor",
): [AIOfficeViewMode, (mode: AIOfficeViewMode) => void] {
  const [mode, setModeState] = useState<AIOfficeViewMode>(() => {
    if (typeof window !== "undefined" && window.location) {
      const sp = new URLSearchParams(window.location.search);
      return sp.get("view") === "neural" ? "neural" : defaultMode;
    }
    return defaultMode;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handlePopState = () => {
      const sp = new URLSearchParams(window.location.search);
      setModeState(sp.get("view") === "neural" ? "neural" : "floor");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const setMode = useCallback((newMode: AIOfficeViewMode) => {
    setModeState(newMode);
    if (typeof window !== "undefined" && window.history) {
      const url = new URL(window.location.href);
      if (newMode === "neural") {
        url.searchParams.set("view", "neural");
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
  const { setBreadcrumbs } = useBreadcrumbs();
  const [emergencyStopConfirmOpen, setEmergencyStopConfirmOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [controlCenterTab, setControlCenterTab] = useControlCenterTab("sre");
  const [viewMode, setViewMode] = useAIOfficeViewMode("floor");
  const [voiceState, setVoiceState] = useState<VoiceBarState>("idle");

  useEffect(() => {
    setBreadcrumbs([{ label: "AI Office" }]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: ["ai-office-2d-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const liveRunsQuery = useQuery({
    queryKey: ["ai-office-2d-live-runs", selectedCompanyId],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const pendingApprovalsQuery = useQuery({
    queryKey: ["ai-office-2d-approvals-pending", selectedCompanyId],
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const orgUnitsQuery = useQuery({
    queryKey: ["ai-office-2d-org-units", selectedCompanyId],
    queryFn: () => agentsApi.orgUnitsStatus(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const statusQuery = useQuery({
    queryKey: ["ai-office-2d-status"],
    queryFn: aiOfficeApi.getStatus,
    refetchInterval: 15_000,
  });

  const costByAgentModelQuery = useQuery({
    queryKey: ["ai-office-2d-cost-by-agent", selectedCompanyId],
    queryFn: () => costsApi.byAgentModel(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const costByProviderQuery = useQuery({
    queryKey: ["ai-office-2d-cost-by-provider", selectedCompanyId],
    queryFn: () => costsApi.byProvider(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const quotaWindowsQuery = useQuery({
    queryKey: ["ai-office-2d-quota", selectedCompanyId],
    queryFn: () => costsApi.quotaWindows(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const dashboardQuery = useQuery({
    queryKey: ["ai-office-dashboard-summary", selectedCompanyId],
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const knowledgeQuery = useQuery({
    queryKey: ["ai-office-knowledge-records", selectedCompanyId],
    queryFn: () => knowledgeApi.listKnowledgeRecords(selectedCompanyId!, { limit: 500 }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const emergencyPauseMutation = useMutation({
    mutationFn: () => companiesApi.emergencyPause(selectedCompanyId!),
    onSuccess: () => setEmergencyStopConfirmOpen(false),
  });

  const agentsState = describeQueryState(agentsQuery);
  const orgUnitsState = describeQueryState(orgUnitsQuery);
  const liveRunsState = describeQueryState(liveRunsQuery);
  const pendingApprovalsState = describeQueryState(pendingApprovalsQuery);

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

  const agents = agentsQuery.data ?? [];
  const liveRunByAgentId = new Map((liveRunsQuery.data ?? []).map((run) => [run.agentId, run]));
  const pendingApprovalAgentIds = new Set(
    (pendingApprovalsQuery.data ?? [])
      .filter((approval) => !!approval.requestedByAgentId)
      .map((approval) => approval.requestedByAgentId as string),
  );
  const orgUnitIdByName = new Map((orgUnitsQuery.data ?? []).map((unit) => [unit.name, unit.orgUnitId]));
  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));
  const now = Date.now();

  // Exact-name lookups only — never a fuzzy/partial match on leadership seats.
  const jarvis = agents.find((agent) => agent.name === "JARVIS");
  const atlas = agents.find((agent) => agent.name === "Atlas");

  const mappedOrgUnitNames = new Set(
    DEPARTMENT_ROOMS.map((room) => room.orgUnitName).filter((name): name is string => !!name),
  );
  const otherOrgUnits = (orgUnitsQuery.data ?? []).filter((unit) => !mappedOrgUnitNames.has(unit.name));

  const blockedOrOfflineAgents = agents
    .map((agent) => ({
      agent,
      condition: deriveAgentCondition(agent, liveRunByAgentId.has(agent.id), now),
    }))
    .filter((entry) => entry.condition !== null);

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
    const state = computeSeatState(agent, !!liveRun, hasPendingApproval, now);
    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.title ?? agent.role,
      state,
      taskSummary: liveRun
        ? (liveRun.currentStatusMessage ?? liveRun.triggerDetail ?? liveRun.lastAssistantSnippet ?? null)
        : null,
    };
  }

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedAgentDetail = selectedAgent ? agentDetailFor(selectedAgent) : null;

  function renderRoom(room: (typeof DEPARTMENT_ROOMS)[number]) {
    const orgUnitId = room.orgUnitName ? orgUnitIdByName.get(room.orgUnitName) : undefined;
    const deptAgents = orgUnitId ? agents.filter((agent) => agent.orgUnitId === orgUnitId) : [];
    const isUnmatched = !room.orgUnitName;

    return (
      <RoomBox key={room.label} label={room.label} icon={DoorOpen} muted={isUnmatched}>
        {isUnmatched ? (
          <EmptyRoomNote note="NEXORA 조직 확정 부서 — 아직 실제 org_unit 데이터 없음" />
        ) : deptAgents.length === 0 ? (
          <EmptyRoomNote note="배정 대기 (배정된 AI 직원 없음)" />
        ) : (
          deptAgents.map((agent) => (
            <Workstation
              key={agent.id}
              name={agent.name}
              role={agent.title ?? agent.role}
              liveRun={liveRunByAgentId.get(agent.id)}
              state={computeSeatState(agent, liveRunByAgentId.has(agent.id), pendingApprovalAgentIds.has(agent.id), now)}
              onClick={() => setSelectedAgentId(agent.id)}
            />
          ))
        )}
      </RoomBox>
    );
  }

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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
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
        <Card>
          <CardContent className="flex flex-col gap-1 p-3 text-sm">
            <span className="text-xs text-muted-foreground">승인 대기</span>
            <StatValue state={pendingApprovalsState} value={pendingApprovalAgentIds.size} />
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

      {/* 뷰 모드 전환 셀렉터 (2D 오피스 | JARVIS 뉴럴 맵) */}
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
            : "JARVIS 지휘 신경망 및 지능형 라우팅 관측"}
        </span>
      </div>

      {viewMode === "neural" ? (
        <JarvisNeuralCommandInterface
          agents={agents}
          orgUnits={orgUnitsQuery.data ?? []}
          liveRuns={liveRunsQuery.data ?? []}
          pendingApprovals={pendingApprovalsQuery.data ?? []}
          completedCount={dashboardQuery.isLoading ? null : (dashboardQuery.data?.tasks.done ?? null)}
          blockedCount={dashboardQuery.isLoading ? null : (dashboardQuery.data?.tasks.blocked ?? null)}
          pendingApprovalCount={
            pendingApprovalsQuery.isLoading
              ? null
              : (pendingApprovalsQuery.data?.filter(
                  (a) => (a as { effectiveStatus?: string }).effectiveStatus === "pending",
                ).length ?? null)
          }
          knowledgeRecords={knowledgeQuery.data ?? []}
          voiceState={voiceState}
          onNavigateToKnowledgeTab={() => setControlCenterTab("knowledge")}
          isLoading={agentsQuery.isLoading || orgUnitsQuery.isLoading}
          error={agentsQuery.error || orgUnitsQuery.error}
          companyId={selectedCompanyId}
        />
      ) : (
        /* 중앙 2D 사무실 + 우측 운영 패널 */
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <div className="space-y-4 lg:col-span-3">
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
            <>
          {/* 경영진 + 비서실 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <RoomBox label="CEO실" icon={Users}>
              <div className="flex w-40 flex-col items-center gap-1 rounded-md border bg-card p-2 text-center text-xs">
                <span className="font-medium">서대곤</span>
                <span className="text-muted-foreground">CEO</span>
                <SeatBadge state="idle" />
                <span className="text-muted-foreground">인간 CEO 고정 조직 자리</span>
              </div>
            </RoomBox>

            <RoomBox label="JARVIS 워크스테이션" icon={Bot}>
              {jarvis ? (
                <Workstation
                  name={jarvis.name}
                  role="CTO / Orchestrator"
                  liveRun={liveRunByAgentId.get(jarvis.id)}
                  state={computeSeatState(
                    jarvis,
                    liveRunByAgentId.has(jarvis.id),
                    pendingApprovalAgentIds.has(jarvis.id),
                    now,
                  )}
                  onClick={() => setSelectedAgentId(jarvis.id)}
                />
              ) : (
                <EmptySeat caption="DB에서 JARVIS 에이전트를 찾을 수 없습니다." />
              )}
            </RoomBox>

            <RoomBox label="COO석" icon={Users} muted={!atlas}>
              {atlas ? (
                <Workstation
                  name={atlas.name}
                  role="COO"
                  liveRun={liveRunByAgentId.get(atlas.id)}
                  state={computeSeatState(
                    atlas,
                    liveRunByAgentId.has(atlas.id),
                    pendingApprovalAgentIds.has(atlas.id),
                    now,
                  )}
                  onClick={() => setSelectedAgentId(atlas.id)}
                />
              ) : (
                <EmptySeat caption="공석 — 아직 Atlas 에이전트가 생성되지 않았습니다." />
              )}
            </RoomBox>

            {renderRoom(SECRETARIAT_ROOM)}
          </div>

          {/* Master 1차 확정 부서 8개 */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {DEPARTMENT_ROOMS.slice(1).map((room) => renderRoom(room))}
          </div>

          {/* 최소 공간 표현 — 장식/시설물. 조직 Room(RoomBox)과 달리 헤더가 없는
              별도 AmenityTile로 렌더해 "조직처럼 보이는" 문제를 구조적으로 차단. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <AmenityTile icon={Sofa} label="회의실" />
            <AmenityTile icon={Coffee} label="라운지" />
            <AmenityTile icon={Sprout} />
            <AmenityTile icon={Sprout} />
          </div>

          {/* 기타 / 미배정 조직 — 실제 DB에는 있으나 Master 1차 8개 부서에는 없는 org_unit */}
          {otherOrgUnits.length > 0 ? (
            <div className="space-y-2 border-t pt-4">
              <h2 className="text-sm font-medium text-muted-foreground">
                기타 / 미배정 조직 (Master 1차 정식 부서 아님 — 실제 데이터만 표시)
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {otherOrgUnits.map((unit) => {
                  const unitAgents = agents.filter((agent) => agent.orgUnitId === unit.orgUnitId);
                  return (
                    <RoomBox key={unit.orgUnitId} label={unit.name} icon={Building2} muted>
                      {unitAgents.length === 0 ? (
                        <EmptyRoomNote note="배정된 AI 직원 없음" />
                      ) : (
                        unitAgents.map((agent) => (
                          <Workstation
                            key={agent.id}
                            name={agent.name}
                            role={agent.title ?? agent.role}
                            liveRun={liveRunByAgentId.get(agent.id)}
                            state={computeSeatState(
                              agent,
                              liveRunByAgentId.has(agent.id),
                              pendingApprovalAgentIds.has(agent.id),
                              now,
                            )}
                            onClick={() => setSelectedAgentId(agent.id)}
                          />
                        ))
                      )}
                    </RoomBox>
                  );
                })}
              </div>
            </div>
          ) : null}
            </>
          )}
        </div>

        {/* 우측 운영 패널 */}
        <aside className="space-y-4 lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">승인 대기</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-xs">
              {pendingApprovalsState.kind !== "data" ? (
                <StateNotice
                  state={pendingApprovalsState}
                  loadingText="승인 데이터 로딩 중"
                  emptyText="대기 중인 승인 없음"
                  errorPrefix="승인 데이터 조회 실패"
                />
              ) : (
                (pendingApprovalsQuery.data ?? []).map((approval) => (
                  <div key={approval.id} className="flex flex-col gap-0.5 border-t pt-2 first:border-t-0 first:pt-0">
                    <span className="font-medium">{approval.type}</span>
                    <span className="text-muted-foreground">
                      {approval.requestedByAgentId
                        ? agents.find((a) => a.id === approval.requestedByAgentId)?.name ?? approval.requestedByAgentId
                        : "—"}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <ShieldAlert className="h-4 w-4" /> 블로커 센터
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-xs">
              {agentsState.kind === "loading" || liveRunsState.kind === "loading" ? (
                <span className="text-muted-foreground">에이전트 상태 로딩 중</span>
              ) : agentsState.kind === "error" ? (
                <span className="text-destructive">에이전트 데이터 조회 실패: {agentsState.message}</span>
              ) : blockedOrOfflineAgents.length === 0 ? (
                <span className="text-muted-foreground">차단/오프라인 에이전트 없음</span>
              ) : (
                blockedOrOfflineAgents.map(({ agent, condition }) => (
                  <div key={agent.id} className="flex items-center justify-between gap-2 border-t pt-2 first:border-t-0 first:pt-0">
                    <span className="truncate font-medium">{agent.name}</span>
                    <SeatBadge state={condition === "error" ? "blocked-error" : "offline"} />
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {selectedCompanyId ? <DecisionQueueRail companyId={selectedCompanyId} /> : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">최근 활동</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ActivityFeed className="max-h-80 overflow-auto p-3" />
            </CardContent>
          </Card>
        </aside>
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
