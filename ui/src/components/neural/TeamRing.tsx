import { AlertTriangle, Clock, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { NeuralTeam } from "./neuralCommandTypes";

export function TeamRing({
  teams,
  selectedTeamId,
  onSelectTeam,
  className,
}: {
  teams: NeuralTeam[];
  selectedTeamId: string | null;
  onSelectTeam: (teamId: string) => void;
  className?: string;
}) {
  return (
    <div
      data-testid="team-ring"
      className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4", className)}
    >
      {teams.map((team) => {
        const isSelected = team.id === selectedTeamId;
        return (
          <button
            key={team.id}
            type="button"
            data-testid={`team-node-${team.id}`}
            onClick={() => onSelectTeam(team.id)}
            className={cn(
              "group relative flex flex-col justify-between rounded-xl border bg-card p-3 text-left transition-all hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              isSelected
                ? "border-primary bg-primary/5 shadow-xs ring-1 ring-primary"
                : "border-border",
            )}
            aria-pressed={isSelected}
            aria-label={`${team.name} 팀 노드`}
          >
            <div className="flex items-center justify-between gap-1.5 pb-2">
              <span className="font-semibold text-xs text-foreground group-hover:text-primary">
                {team.name}
              </span>
              <div className="flex items-center gap-1">
                {team.hasApprovalWaiting ? (
                  <Clock
                    className="h-3.5 w-3.5 text-amber-500"
                    aria-label="승인 대기 존재"
                  />
                ) : null}
                {team.hasFailure ? (
                  <AlertTriangle
                    className="h-3.5 w-3.5 text-destructive"
                    aria-label="이상 감지"
                  />
                ) : null}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <Users className="h-3 w-3" aria-hidden="true" />
                <span>{team.agentIds.length}명</span>
              </div>
              {team.activeTaskCount > 0 ? (
                <Badge variant="secondary" className="px-1.5 py-0 text-xs">
                  {team.activeTaskCount}건 실행
                </Badge>
              ) : (
                <span className="text-muted-foreground">대기</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
