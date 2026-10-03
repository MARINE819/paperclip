import { Bot, CheckCircle2, Clock, Flame, ShieldAlert, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NeuralExecutionStatus } from "./neuralCommandTypes";

export function CentralJarvisCore({
  status = "idle",
  teamCount = 0,
  agentCount = 0,
  activeTaskCount = 0,
  pendingApprovalCount = 0,
  isSelected = false,
  onClick,
}: {
  status?: NeuralExecutionStatus;
  teamCount?: number;
  agentCount?: number;
  activeTaskCount?: number;
  pendingApprovalCount?: number;
  isSelected?: boolean;
  onClick?: () => void;
}) {
  const statusConfig = {
    running: {
      label: "실행 중",
      borderClass: "border-blue-500",
      glowClass: "shadow-md shadow-blue-500/20",
      icon: Sparkles,
      iconClass: "text-blue-500",
    },
    approval_waiting: {
      label: "승인 대기",
      borderClass: "border-amber-500",
      glowClass: "shadow-md shadow-amber-500/20",
      icon: Clock,
      iconClass: "text-amber-500",
    },
    failed: {
      label: "이상 감지",
      borderClass: "border-destructive",
      glowClass: "shadow-md shadow-destructive/20",
      icon: Flame,
      iconClass: "text-destructive",
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
        {status === "running" ? (
          <span
            className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5"
            aria-hidden="true"
          >
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75 motion-reduce:animate-none" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-blue-500" />
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Neural Command Hub
        </span>
        <span className="text-lg font-bold text-foreground">JARVIS Core</span>
        <span className="text-xs font-medium text-muted-foreground">
          {current.label}
        </span>
      </div>

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
              pendingApprovalCount > 0 ? "text-amber-500" : "text-foreground",
            )}
          >
            {pendingApprovalCount}건
          </span>
        </div>
      </div>
    </button>
  );
}
