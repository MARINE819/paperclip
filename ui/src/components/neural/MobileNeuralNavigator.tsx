import { useState } from "react";
import { ArrowLeft, Bot, ChevronRight, Layers, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NeuralExecutionRoute, NeuralTeam } from "./neuralCommandTypes";
import { CentralJarvisCore } from "./CentralJarvisCore";
import { AgentStatusNode } from "./AgentStatusNode";
import { ExecutionRoutePanel } from "./ExecutionRoutePanel";

export type MobileStage = "core" | "team" | "agent" | "execution";

export function MobileNeuralNavigator({
  teams,
  agents,
  routesByAgentId,
  selectedTeamId,
  selectedAgentId,
  onSelectTeam,
  onSelectAgent,
  className,
}: {
  teams: NeuralTeam[];
  agents: Array<{ id: string; name: string; title?: string | null; role: string; orgUnitId?: string | null }>;
  routesByAgentId: Map<string, NeuralExecutionRoute>;
  selectedTeamId: string | null;
  selectedAgentId: string | null;
  onSelectTeam: (teamId: string | null) => void;
  onSelectAgent: (agentId: string | null) => void;
  className?: string;
}) {
  const [currentStage, setCurrentStage] = useState<MobileStage>("core");

  const selectedTeam = teams.find((t) => t.id === selectedTeamId) ?? null;
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const selectedRoute = selectedAgentId ? routesByAgentId.get(selectedAgentId) ?? null : null;

  const teamAgents = selectedTeam
    ? agents.filter((a) => selectedTeam.agentIds.includes(a.id))
    : [];

  const handlePickTeam = (teamId: string) => {
    onSelectTeam(teamId);
    setCurrentStage("team");
  };

  const handlePickAgent = (agentId: string) => {
    onSelectAgent(agentId);
    setCurrentStage("execution");
  };

  return (
    <div
      data-testid="mobile-neural-navigator"
      className={cn("flex flex-col gap-4 pb-8", className)}
    >
      {/* Mobile Stage Stepper Bar */}
      <div className="flex items-center justify-between rounded-lg border bg-muted/50 p-2 text-xs">
        <button
          type="button"
          onClick={() => setCurrentStage("core")}
          className={cn(
            "flex items-center gap-1 font-medium transition-colors hover:text-primary",
            currentStage === "core" ? "text-primary font-bold" : "text-muted-foreground",
          )}
        >
          <Bot className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Core</span>
        </button>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <button
          type="button"
          disabled={!selectedTeam}
          onClick={() => setCurrentStage("team")}
          className={cn(
            "flex items-center gap-1 font-medium transition-colors hover:text-primary disabled:opacity-40",
            currentStage === "team" ? "text-primary font-bold" : "text-muted-foreground",
          )}
        >
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{selectedTeam ? selectedTeam.name : "Team"}</span>
        </button>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <button
          type="button"
          disabled={!selectedAgent}
          onClick={() => setCurrentStage("execution")}
          className={cn(
            "flex items-center gap-1 font-medium transition-colors hover:text-primary disabled:opacity-40",
            currentStage === "execution" ? "text-primary font-bold" : "text-muted-foreground",
          )}
        >
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{selectedAgent ? selectedAgent.name : "Route"}</span>
        </button>
      </div>

      {/* Stage 1: Central Core & Team List */}
      {currentStage === "core" && (
        <div data-testid="mobile-stage-core" className="flex flex-col gap-4">
          <CentralJarvisCore
            status="running"
            teamCount={teams.length}
            agentCount={agents.length}
            activeTaskCount={teams.reduce((acc, t) => acc + t.activeTaskCount, 0)}
            pendingApprovalCount={teams.filter((t) => t.hasApprovalWaiting).length}
          />

          <div className="flex flex-col gap-2">
            <h3 className="font-semibold text-xs tracking-wider text-muted-foreground uppercase">
              부서 / 팀 선택 (총 {teams.length}개)
            </h3>
            <div className="flex flex-col gap-2">
              {teams.map((team) => (
                <button
                  key={team.id}
                  type="button"
                  data-testid={`mobile-team-btn-${team.id}`}
                  onClick={() => handlePickTeam(team.id)}
                  className="flex min-h-11 items-center justify-between rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/50"
                >
                  <div className="flex items-center gap-2.5">
                    <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="font-semibold text-sm">{team.name}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{team.agentIds.length}명</span>
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Stage 2: Team View & Agent Roster */}
      {currentStage === "team" && selectedTeam && (
        <div data-testid="mobile-stage-team" className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentStage("core")}
              className="min-h-11"
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" /> 코어로 돌아가기
            </Button>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-base">{selectedTeam.name}</h3>
              <span className="text-xs text-muted-foreground">
                소속 {teamAgents.length}명
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h4 className="font-semibold text-xs text-muted-foreground uppercase">
              에이전트 선택
            </h4>
            {teamAgents.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                이 팀에 배정된 에이전트가 없습니다.
              </p>
            ) : (
              teamAgents.map((agent) => {
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
                    onClick={() => handlePickAgent(agent.id)}
                    className="min-h-11"
                  />
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Stage 3/4: Execution Route Detail */}
      {currentStage === "execution" && selectedAgent && (
        <div data-testid="mobile-stage-execution" className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentStage(selectedTeam ? "team" : "core")}
              className="min-h-11"
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" /> 에이전트 목록으로
            </Button>
          </div>

          {selectedRoute ? (
            <ExecutionRoutePanel route={selectedRoute} />
          ) : (
            <div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
              선택된 에이전트의 활성 라우팅 정보가 없습니다.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
