import { Bot, CheckCircle2, Clock, Flame, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { NeuralExecutionRoute, NeuralExecutionStatus } from "./neuralCommandTypes";

export function AgentStatusNode({
  agentId,
  name,
  role,
  status = "idle",
  currentTaskTitle,
  route,
  isSelected = false,
  onClick,
  className,
}: {
  agentId: string;
  name: string;
  role?: string | null;
  status?: NeuralExecutionStatus;
  currentTaskTitle?: string | null;
  route?: NeuralExecutionRoute | null;
  isSelected?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const statusConfig = {
    running: {
      label: "업무 중",
      borderClass: "border-blue-500/50 bg-blue-500/5",
      badgeClass: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
      icon: Sparkles,
    },
    approval_waiting: {
      label: "승인 대기",
      borderClass: "border-amber-500/50 bg-amber-500/5",
      badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      icon: Clock,
    },
    failed: {
      label: "오류/차단",
      borderClass: "border-destructive/50 bg-destructive/5",
      badgeClass: "border-destructive/30 bg-destructive/10 text-destructive",
      icon: Flame,
    },
    done: {
      label: "완료",
      borderClass: "border-emerald-500/50 bg-emerald-500/5",
      badgeClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      icon: CheckCircle2,
    },
    idle: {
      label: "대기",
      borderClass: "border-border bg-card",
      badgeClass: "border-border bg-muted text-muted-foreground",
      icon: Bot,
    },
  };

  const current = statusConfig[status] ?? statusConfig.idle;
  const StatusIcon = current.icon;

  return (
    <button
      type="button"
      data-testid={`agent-node-${agentId}`}
      onClick={onClick}
      className={cn(
        "group relative flex flex-col justify-between rounded-xl border p-3 text-left transition-all hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        current.borderClass,
        isSelected ? "ring-2 ring-primary ring-offset-1" : "shadow-xs",
        className,
      )}
      aria-pressed={isSelected}
      aria-label={`${name} (${role ?? "에이전트"}) 상태: ${current.label}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold text-sm text-foreground group-hover:text-primary">
            {name}
          </span>
          <span className="text-xs text-muted-foreground">{role ?? "직무 미지정"}</span>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
            current.badgeClass,
          )}
        >
          <StatusIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
          {current.label}
        </span>
      </div>

      {currentTaskTitle ? (
        <p className="mt-2 line-clamp-1 text-xs text-muted-foreground">
          {currentTaskTitle}
        </p>
      ) : null}

      {route ? (
        <div className="mt-2 flex flex-wrap items-center gap-1 border-t pt-2 text-xs">
          <Badge variant="outline" className="text-xs font-mono">
            {route.executor}
          </Badge>
          <span className="text-muted-foreground">&rarr;</span>
          <Badge variant="secondary" className="text-xs">
            {route.model}
          </Badge>
          {route.fallbackUsed ? (
            <Badge variant="outline" className="border-amber-500/30 text-amber-500 text-xs">
              Fallback
            </Badge>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}
