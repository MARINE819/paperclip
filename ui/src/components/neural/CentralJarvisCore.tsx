import {
  Bot,
  CheckCircle2,
  Clock,
  Cpu,
  Flame,
  Layers,
  Mic,
  Network,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { JarvisCoreState, NeuralExecutionStatus } from "./neuralCommandTypes";

export interface CentralJarvisCoreProps {
  status?: NeuralExecutionStatus | JarvisCoreState;
  teamCount?: number;
  agentCount?: number;
  activeTaskCount?: number;
  pendingApprovalCount?: number | null;
  isSelected?: boolean;
  currentTaskTitle?: string | null;
  currentTeamName?: string | null;
  currentAgentName?: string | null;
  /**
   * Terminal execution telemetry: strictly populated ONLY from terminal runs
   * (succeeded / failed / timed_out) where real backend values were recorded.
   * Never speculated or guessed during active (queued / running) runs.
   */
  terminalRunId?: string | null;
  terminalExecutor?: string | null;
  terminalProvider?: string | null;
  terminalModel?: string | null;
  recentResultSummary?: string | null;
  onClick?: () => void;
}

export function CentralJarvisCore({
  status = "idle",
  teamCount = 0,
  agentCount = 0,
  activeTaskCount = 0,
  pendingApprovalCount = 0,
  isSelected = false,
  currentTaskTitle,
  currentTeamName,
  currentAgentName,
  terminalExecutor,
  terminalModel,
  recentResultSummary,
  onClick,
}: CentralJarvisCoreProps) {
  const statusConfig: Record<
    string,
    {
      label: string;
      uiOnlyBadge?: string;
      borderClass: string;
      glowClass: string;
      icon: typeof Bot;
      iconClass: string;
      pulseColor?: string;
    }
  > = {
    listening: {
      label: "음성 청취 중",
      uiOnlyBadge: "UI 전용",
      borderClass: "border-violet-500",
      glowClass: "shadow-md shadow-violet-500/20",
      icon: Mic,
      iconClass: "text-violet-500",
      pulseColor: "bg-violet-500",
    },
    planning: {
      label: "명령 계획/분해",
      uiOnlyBadge: "UI 전용",
      borderClass: "border-cyan-500",
      glowClass: "shadow-md shadow-cyan-500/20",
      icon: Network,
      iconClass: "text-cyan-500",
      pulseColor: "bg-cyan-500",
    },
    dispatching: {
      label: "에이전트 배치 중",
      uiOnlyBadge: "대기열 UI",
      borderClass: "border-indigo-500",
      glowClass: "shadow-md shadow-indigo-500/20",
      icon: Layers,
      iconClass: "text-indigo-500",
      pulseColor: "bg-indigo-500",
    },
    working: {
      label: "작업 수행 중",
      borderClass: "border-blue-500",
      glowClass: "shadow-md shadow-blue-500/20",
      icon: Sparkles,
      iconClass: "text-blue-500",
      pulseColor: "bg-blue-500",
    },
    running: {
      label: "작업 수행 중",
      borderClass: "border-blue-500",
      glowClass: "shadow-md shadow-blue-500/20",
      icon: Sparkles,
      iconClass: "text-blue-500",
      pulseColor: "bg-blue-500",
    },
    approval: {
      label: "결재 승인 대기",
      borderClass: "border-amber-500",
      glowClass: "shadow-md shadow-amber-500/20",
      icon: Clock,
      iconClass: "text-amber-500",
      pulseColor: "bg-amber-500",
    },
    approval_waiting: {
      label: "결재 승인 대기",
      borderClass: "border-amber-500",
      glowClass: "shadow-md shadow-amber-500/20",
      icon: Clock,
      iconClass: "text-amber-500",
      pulseColor: "bg-amber-500",
    },
    error: {
      label: "이상 감지",
      borderClass: "border-destructive",
      glowClass: "shadow-md shadow-destructive/20",
      icon: Flame,
      iconClass: "text-destructive",
      pulseColor: "bg-destructive",
    },
    failed: {
      label: "이상 감지",
      borderClass: "border-destructive",
      glowClass: "shadow-md shadow-destructive/20",
      icon: Flame,
      iconClass: "text-destructive",
      pulseColor: "bg-destructive",
    },
    done: {
      label: "정상 완료",
      borderClass: "border-emerald-500",
      glowClass: "shadow-md shadow-emerald-500/20",
      icon: CheckCircle2,
      iconClass: "text-emerald-500",
    },
    idle: {
      label: "명령 대기",
      borderClass: "border-border",
      glowClass: "",
      icon: Bot,
      iconClass: "text-muted-foreground",
    },
  };

  const current = statusConfig[status] ?? statusConfig.idle;
  const StatusIcon = current.icon;
  const isPulsing = Boolean(current.pulseColor);
  const isTerminalStatus = status === "done" || status === "error" || status === "failed";

  return (
    <button
      type="button"
      data-testid="central-jarvis-core"
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-center justify-center rounded-2xl border-2 bg-card p-6 text-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        current.borderClass,
        current.glowClass,
        isSelected && "ring-2 ring-primary ring-offset-2",
      )}
      aria-label={`JARVIS 코어 상태: ${current.label}`}
    >
      <div className="relative mb-3 flex h-16 w-16 items-center justify-center rounded-full border border-border bg-muted/50">
        <StatusIcon
          className={cn("h-8 w-8 transition-transform group-hover:scale-110", current.iconClass)}
          aria-hidden="true"
        />
        {isPulsing ? (
          <span
            className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5"
            aria-hidden="true"
          >
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:animate-none",
                current.pulseColor,
              )}
            />
            <span
              className={cn("relative inline-flex h-3.5 w-3.5 rounded-full", current.pulseColor)}
            />
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Neural Command Hub
        </span>
        <span className="text-lg font-bold text-foreground">JARVIS Core</span>
        <div className="flex items-center justify-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {current.label}
          </span>
          {current.uiOnlyBadge ? (
            <span className="rounded-sm bg-muted/80 px-1 py-0.5 text-xs text-muted-foreground font-mono">
              {current.uiOnlyBadge}
            </span>
          ) : null}
        </div>
      </div>

      {/* Terminal execution telemetry: strictly only for terminal runs (succeeded / failed) where backend actually saved values */}
      {isTerminalStatus && (terminalExecutor || recentResultSummary) ? (
        <div className="mt-3 flex flex-col gap-1 w-full rounded-lg bg-muted/30 p-2 text-left text-xs border border-border/50">
          <div className="flex items-center justify-between text-muted-foreground text-xs">
            <span>
              {currentTeamName ? `${currentTeamName} · ` : ""}
              {currentAgentName ?? "완료 에이전트"}
            </span>
            {terminalExecutor ? (
              <span className="flex items-center gap-1 font-mono text-primary text-xs">
                <Cpu className="h-3 w-3" />
                {terminalExecutor}
                {terminalModel ? ` / ${terminalModel}` : ""}
              </span>
            ) : null}
          </div>
          {status === "done" && recentResultSummary ? (
            <div className="truncate text-emerald-600 dark:text-emerald-400 font-medium text-xs">
              결과: {recentResultSummary}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Active task in progress: show current task and agent ONLY, without guessing executor/provider/model */}
      {(status === "working" || status === "running") && (currentTaskTitle || currentAgentName) ? (
        <div className="mt-3 flex flex-col gap-1 w-full rounded-lg bg-blue-500/10 p-2 text-left text-xs border border-blue-500/20">
          {currentTaskTitle ? (
            <div className="truncate font-medium text-foreground">
              {currentTaskTitle}
            </div>
          ) : null}
          <div className="text-muted-foreground text-xs">
            진행 에이전트: {currentTeamName ? `${currentTeamName} · ` : ""}{currentAgentName ?? "미지정"}
          </div>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2 border-t pt-3 text-xs w-full">
        <div className="flex flex-col">
          <span className="text-muted-foreground">연결 팀</span>
          <span className="font-semibold text-foreground">{teamCount}개</span>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground">에이전트</span>
          <span className="font-semibold text-foreground">{agentCount}명</span>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground">실행 중</span>
          <span className="font-semibold text-foreground">{activeTaskCount}건</span>
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground">결재 대기</span>
          <span
            className={cn(
              "font-semibold",
              pendingApprovalCount !== null && pendingApprovalCount > 0
                ? "text-amber-500"
                : "text-foreground",
            )}
          >
            {pendingApprovalCount !== null ? `${pendingApprovalCount}건` : "—"}
          </span>
        </div>
      </div>
    </button>
  );
}

