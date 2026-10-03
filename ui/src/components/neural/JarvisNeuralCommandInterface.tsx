import { useMemo, useState } from "react";
import { Bot, Network, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  NeuralDataSource,
  NeuralExecutionRoute,
} from "./neuralCommandTypes";
import { CentralJarvisCore } from "./CentralJarvisCore";
import { TeamRing } from "./TeamRing";
import { AgentStatusNode } from "./AgentStatusNode";
import { ExecutionRoutePanel } from "./ExecutionRoutePanel";
import { MobileNeuralNavigator } from "./MobileNeuralNavigator";
import { BackendPendingBanner } from "./ExecutionRouteNodes";
import { useNeuralCommandData } from "./useNeuralCommandData";

export interface JarvisNeuralCommandInterfaceProps {
  agents?: Array<{
    id: string;
    name: string;
    title?: string | null;
    role: string;
    orgUnitId?: string | null;
    status: string;
    lastHeartbeatAt?: string | Date | null;
  }>;
  orgUnits?: Array<{
    orgUnitId: string;
    name: string;
  }>;
  liveRuns?: Array<{
    agentId: string;
    triggerDetail?: string | null;
    currentStatusMessage?: string | null;
  }>;
  pendingApprovals?: Array<{
    id: string;
    type: string;
    requestedByAgentId?: string | null;
  }>;
  isLoading?: boolean;
  error?: Error | string | null;
  sourceOverride?: NeuralDataSource;
  fixtureRoutesOverride?: Record<string, NeuralExecutionRoute>;
  /**
   * Company id to fetch real Neural routing telemetry for (Phase 2B MVP).
   * Forwarded as-is into useNeuralCommandData — omit to keep the exact
   * fixture-only behavior (see useNeuralCommandData's own companyId doc).
   */
  companyId?: string | null;
  className?: string;
}

export function JarvisNeuralCommandInterface({
  agents = [],
  orgUnits = [],
  liveRuns = [],
  pendingApprovals = [],
  isLoading = false,
  error = null,
  sourceOverride,
  fixtureRoutesOverride,
  companyId,
  className,
}: JarvisNeuralCommandInterfaceProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>("team-planning");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>("agent-pm-1");

  const viewModel = useNeuralCommandData({
    agents,
    orgUnits,
    liveRuns,
    pendingApprovals,
    isLoading,
    error,
    selectedTeamId,
    selectedAgentId,
    sourceOverride,
    fixtureRoutesOverride,
    companyId,
  });

  const {
    state,
    source,
    teams,
    routesByAgentId,
    activeRoute,
    sourceLabel,
    backendIntegrationPending,
  } = viewModel;

  const selectedTeam = teams.find((t) => t.id === selectedTeamId) ?? teams[0] ?? null;

  const visibleAgents = agents.filter((a) =>
    selectedTeam ? selectedTeam.agentIds.includes(a.id) : true,
  );

  const displayAgents = visibleAgents.length > 0 ? visibleAgents : activeRoute ? [{
    id: activeRoute.agentId,
    name: activeRoute.agentName,
    title: "담당 에이전트",
    role: "전문가",
    orgUnitId: null,
    status: activeRoute.status,
  }] : [];

  return (
    <div
      data-testid="jarvis-neural-command-interface"
      className={cn("flex flex-col gap-6", className)}
    >
      {/* Top Banner / Header (Always present common shell) */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Network className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="flex flex-wrap items-center gap-2 font-bold text-lg text-foreground">
              <span>JARVIS Neural Command Map</span>
              <Badge variant="outline" className="text-xs font-mono">
                v1.0
              </Badge>
              <Badge
                variant="outline"
                className="border-amber-500/40 text-amber-600 dark:text-amber-400 gap-1 text-xs"
                data-testid="neural-source-badge"
              >
                <Sparkles className="h-3 w-3" />
                <span>{sourceLabel}</span>
              </Badge>
            </h2>
            <p className="text-xs text-muted-foreground">
              NEXORA 인공지능 지휘 계통 및 지능형 라우팅 실행 사슬 실시간 관측
            </p>
          </div>
        </div>

        {backendIntegrationPending ? (
          <BackendPendingBanner source={source} className="w-full sm:w-auto" />
        ) : null}
      </div>

      {/* Body Area: Conditional Rendering by State */}
      {state === "loading" ? (
        <Card
          data-testid="neural-loading-state"
          role="status"
          aria-busy="true"
          className="flex flex-col items-center justify-center p-12 text-center"
        >
          <Sparkles className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
          <h3 className="mt-4 font-semibold text-base">JARVIS 지휘 신경망 데이터 로딩 중</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            조직도 및 라우팅 텔레메트리 파이프라인을 동기화하고 있습니다...
          </p>
        </Card>
      ) : state === "error" ? (
        <Card
          data-testid="neural-error-state"
          role="alert"
          className="border-destructive/40 bg-destructive/5 p-8 text-center"
        >
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <Bot className="h-6 w-6" aria-hidden="true" />
          </div>
          <h3 className="mt-4 font-bold text-base text-destructive">
            신경망 관측 데이터 조회 오류
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {viewModel.error ?? "에이전트 또는 부서 텔레메트리를 불러오는 중 오류가 발생했습니다."}
          </p>
        </Card>
      ) : state === "empty" ? (
        <Card
          data-testid="neural-empty-state"
          className="flex flex-col items-center justify-center p-12 text-center"
        >
          <Network className="h-10 w-10 text-muted-foreground/60" aria-hidden="true" />
          <h3 className="mt-4 font-semibold text-base">등록된 부서 또는 에이전트가 없습니다</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            AI 에이전트 또는 부서가 배정되면 JARVIS 뉴럴 맵이 자동으로 구성됩니다.
          </p>
        </Card>
      ) : (
        <>
          {/* Desktop / Tablet Neural Graph Layout */}
          <div className="hidden md:flex flex-col gap-6">
        {/* Top Tier: Central Core & Overview Stats */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <CentralJarvisCore
              status={activeRoute?.status ?? "idle"}
              teamCount={teams.length}
              agentCount={agents.length > 0 ? agents.length : 5}
              activeTaskCount={teams.reduce((acc, t) => acc + t.activeTaskCount, 0)}
              pendingApprovalCount={teams.filter((t) => t.hasApprovalWaiting).length}
              isSelected={selectedAgentId === "agent-jarvis-core"}
              onClick={() => {
                setSelectedTeamId("team-exec");
                setSelectedAgentId("agent-jarvis-core");
              }}
            />
          </div>

          {/* Team Ring Clustered around Core */}
          <div className="flex flex-col justify-between gap-3 rounded-2xl border border-border bg-card p-4 lg:col-span-2">
            <div className="flex items-center justify-between border-b pb-2">
              <span className="font-semibold text-xs tracking-wider text-muted-foreground uppercase">
                부서 / 조직 네트워크 (Team Ring)
              </span>
              <span className="text-xs text-muted-foreground">
                팀 클릭 시 소속 에이전트 표시
              </span>
            </div>
            <TeamRing
              teams={teams}
              selectedTeamId={selectedTeamId}
              onSelectTeam={(teamId) => {
                setSelectedTeamId(teamId);
                const team = teams.find((t) => t.id === teamId);
                if (team && team.agentIds.length > 0) {
                  setSelectedAgentId(team.agentIds[0]!);
                }
              }}
            />
          </div>
        </div>

        {/* Middle Tier: Agent Roster for Selected Team */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-bold text-sm">
              <span>{selectedTeam ? selectedTeam.name : "전체"} 소속 에이전트</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {displayAgents.length}명
              </span>
            </h3>
            <span className="text-xs text-muted-foreground">
              에이전트를 클릭하면 상세 라우팅 경로가 갱신됩니다
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {displayAgents.map((agent) => {
              const route = routesByAgentId.get(agent.id);
              return (
                <AgentStatusNode
                  key={agent.id}
                  agentId={agent.id}
                  name={agent.name}
                  role={agent.title ?? agent.role}
                  status={route?.status ?? "idle"}
                  currentTaskTitle={route?.taskTitle}
                  route={route}
                  isSelected={selectedAgentId === agent.id}
                  onClick={() => setSelectedAgentId(agent.id)}
                />
              );
            })}
          </div>
        </div>

        {/* Lower Tier: Execution Route Panel (WHO / WHY / Fallback) */}
        {activeRoute ? (
          <div className="flex flex-col gap-2">
            <h3 className="font-bold text-sm">
              실시간 라우팅 의사결정 상세 (Execution Route)
            </h3>
            <ExecutionRoutePanel route={activeRoute} />
          </div>
        ) : null}
      </div>

      {/* Mobile Staged Navigation Layout */}
      <div className="flex md:hidden flex-col">
        <MobileNeuralNavigator
          teams={teams}
          agents={agents.length > 0 ? agents : [
            { id: "agent-pm-1", name: "윤지우", role: "기획·전략팀장", title: "PM", orgUnitId: null },
            { id: "agent-dev-1", name: "백지수", role: "지식관리", title: "Knowledge", orgUnitId: null },
            { id: "agent-audit-1", name: "임도현", role: "시스템감시", title: "Audit", orgUnitId: null },
            { id: "agent-qa-1", name: "정하은", role: "품질보증", title: "QA", orgUnitId: null },
            { id: "agent-jarvis-core", name: "JARVIS", role: "CTO / Orchestrator", title: "CTO", orgUnitId: null },
          ]}
          routesByAgentId={routesByAgentId}
          selectedTeamId={selectedTeamId}
          selectedAgentId={selectedAgentId}
          onSelectTeam={setSelectedTeamId}
          onSelectAgent={setSelectedAgentId}
        />
      </div>
        </>
      )}
    </div>
  );
}
