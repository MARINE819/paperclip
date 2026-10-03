import { ArrowDown, ArrowRight, Bot, CheckCircle2, Clock, Flame, ShieldAlert, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { NeuralExecutionRoute } from "./neuralCommandTypes";
import {
  ApprovalWaitingIndicator,
  BackendPendingBanner,
  ExecutorNode,
  FallbackIndicator,
  IncidentStateIndicator,
  ModelNode,
  ProviderNode,
  RoutingDecisionBadge,
} from "./ExecutionRouteNodes";

export function ExecutionRoutePanel({
  route,
  className,
}: {
  route: NeuralExecutionRoute;
  className?: string;
}) {
  const statusConfig = {
    running: {
      label: "실행 중",
      className: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
      icon: Sparkles,
    },
    approval_waiting: {
      label: "승인 대기",
      className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      icon: Clock,
    },
    failed: {
      label: "실패",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
      icon: Flame,
    },
    done: {
      label: "완료",
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      icon: CheckCircle2,
    },
    idle: {
      label: "대기",
      className: "border-border bg-muted text-muted-foreground",
      icon: Clock,
    },
  };

  const currentStatus = statusConfig[route.status] ?? statusConfig.idle;
  const StatusIcon = currentStatus.icon;

  return (
    <Card data-testid="execution-route-panel" className={cn("overflow-hidden", className)}>
      <CardHeader className="flex flex-col gap-2 border-b p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <CardTitle className="text-base font-semibold">
              실행 사슬 분석 (Execution Chain)
            </CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <span
              data-testid="execution-status-badge"
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap",
                currentStatus.className,
              )}
            >
              <StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {currentStatus.label}
            </span>
            <Badge variant="outline" className="text-xs">
              Router v{route.routerVersion}
            </Badge>
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{route.teamName}</span> &gt;{" "}
          <span className="font-medium text-foreground">{route.agentName}</span>: {route.taskTitle}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 p-4">
        {/* Core Hierarchy Path Breadcrumb */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            <Bot className="h-4 w-4" aria-hidden="true" />
            <span>JARVIS Core</span>
          </div>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="rounded-md border bg-card px-2 py-0.5 font-medium">{route.teamName}</span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="rounded-md border bg-card px-2 py-0.5 font-medium">{route.agentName}</span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <RoutingDecisionBadge
            reason={route.selectionReason}
            difficultyTier={route.difficultyTier}
          />
        </div>

        {/* Dynamic AI Execution Nodes (Executor -> Provider -> Model) */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <ExecutorNode
            executor={route.executor}
            verificationStatus={route.verificationStatus}
            capabilityMatch={route.capabilityMatch}
          />
          <ProviderNode provider={route.provider} />
          <ModelNode
            model={route.model}
            costClass={route.costClass}
            latencyClass={route.latencyClass}
          />
        </div>

        {/* Fallback Trace if occurred */}
        {route.fallbackUsed ? (
          <FallbackIndicator fallbackChain={route.fallbackChain} />
        ) : null}

        {/* Approval Waiting Warning */}
        {route.status === "approval_waiting" && route.approvalInfo ? (
          <ApprovalWaitingIndicator approvalInfo={route.approvalInfo} />
        ) : null}

        {/* Incident State Warning */}
        {route.incidentInfo ? (
          <IncidentStateIndicator incidentInfo={route.incidentInfo} />
        ) : null}

        {/* Telemetry Summary */}
        <div className="grid grid-cols-2 gap-2 border-t pt-3 text-xs sm:grid-cols-4">
          <div>
            <span className="text-muted-foreground">예상 비용:</span>{" "}
            <span className="font-medium text-foreground">{route.estimatedCost ?? "—"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">실제 비용:</span>{" "}
            <span className="font-medium text-foreground">{route.actualCost ?? "—"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">소요 시간:</span>{" "}
            <span className="font-medium text-foreground">{route.duration ?? "—"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">검증 상태:</span>{" "}
            <span className="font-medium text-foreground">
              {route.verificationStatus === "confirmed_working" ? "정상 검증" : "테스트/미검증"}
            </span>
          </div>
        </div>

        {/* Backend Pending Notice */}
        {route.backendIntegrationPending ? <BackendPendingBanner /> : null}
      </CardContent>
    </Card>
  );
}
