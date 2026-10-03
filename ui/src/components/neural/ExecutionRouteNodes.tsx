import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Flame,
  Layers,
  Repeat,
  ShieldAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  CostClass,
  FallbackCandidate,
  LatencyClass,
  NeuralDataSource,
  VerificationStatus,
} from "./neuralCommandTypes";

export function BackendPendingBanner({
  className,
  source = "fixture",
}: {
  className?: string;
  source?: NeuralDataSource;
}) {
  return (
    <div
      data-testid="backend-pending-banner"
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="font-semibold">BACKEND_INTEGRATION_PENDING</span>
        <Badge
          variant="outline"
          className="border-amber-500/40 text-xs text-amber-600 dark:text-amber-400"
        >
          {source === "mixed" ? "혼합 모드" : "시뮬레이션 픽스처"}
        </Badge>
      </div>
      <span className="text-muted-foreground">
        지능형 라우터 텔레메트리 연동 대기 (프론트엔드 시각화 픽스처)
      </span>
    </div>
  );
}

export function RoutingDecisionBadge({
  reason,
  difficultyTier,
  className,
}: {
  reason: string;
  difficultyTier?: "T1" | "T2" | "T3" | "T4";
  className?: string;
}) {
  const reasonLabels: Record<string, string> = {
    tier_routing: "티어 적합 매칭",
    adapter_default_fallback: "어댑터 기본값",
    agent_explicit_override: "명시적 오버라이드",
    fallback_routing: "폴백 동적 할당",
    no_route_available: "경로 없음",
  };

  const label = reasonLabels[reason] ?? reason;

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <Badge variant="outline" className="text-xs font-medium">
        {label}
      </Badge>
      {difficultyTier ? (
        <Badge variant="secondary" className="text-xs font-semibold">
          {difficultyTier}
        </Badge>
      ) : null}
    </div>
  );
}

export function ExecutorNode({
  executor,
  verificationStatus,
  capabilityMatch = [],
  className,
}: {
  executor: string;
  verificationStatus: VerificationStatus;
  capabilityMatch?: string[];
  className?: string;
}) {
  const isVerified = verificationStatus === "confirmed_working";

  return (
    <div
      data-testid="executor-node"
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-xs",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs font-medium text-muted-foreground">Executor</span>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
            isVerified
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
          )}
        >
          {isVerified ? (
            <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
          )}
          {isVerified ? "검증 완료" : "미검증/자가테스트"}
        </span>
      </div>
      <div className="font-semibold text-sm text-foreground">{executor}</div>
      {capabilityMatch.length > 0 ? (
        <div className="flex flex-wrap gap-1 pt-1">
          {capabilityMatch.map((cap) => (
            <span
              key={cap}
              className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              {cap}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderNode({
  provider,
  className,
}: {
  provider: string;
  className?: string;
}) {
  return (
    <div
      data-testid="provider-node"
      className={cn(
        "flex flex-col gap-1 rounded-lg border border-border bg-card p-3 shadow-xs",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Layers className="h-4 w-4" aria-hidden="true" />
        <span>Provider</span>
      </div>
      <div className="font-semibold text-sm text-foreground uppercase tracking-wider">
        {provider}
      </div>
    </div>
  );
}

export function ModelNode({
  model,
  costClass,
  latencyClass,
  className,
}: {
  model: string;
  costClass?: CostClass;
  latencyClass?: LatencyClass;
  className?: string;
}) {
  return (
    <div
      data-testid="model-node"
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-xs",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Activity className="h-4 w-4" aria-hidden="true" />
          <span>Selected Model</span>
        </div>
        <div className="flex gap-1">
          {costClass ? (
            <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              비용 {costClass.toUpperCase()}
            </span>
          ) : null}
          {latencyClass ? (
            <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              지연 {latencyClass}
            </span>
          ) : null}
        </div>
      </div>
      <div className="font-semibold text-sm text-foreground">{model}</div>
    </div>
  );
}

export function FallbackIndicator({
  fallbackChain = [],
  className,
}: {
  fallbackChain?: FallbackCandidate[];
  className?: string;
}) {
  if (fallbackChain.length === 0) return null;

  return (
    <div
      data-testid="fallback-indicator"
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 font-semibold">
        <Repeat className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>폴백 재시도 이력 ({fallbackChain.length}회 발생)</span>
      </div>
      <div className="flex flex-col gap-1 pt-1 text-muted-foreground">
        {fallbackChain.map((item, idx) => (
          <div key={`${item.executor}-${idx}`} className="flex items-center justify-between gap-2">
            <span>
              1차 실패: {item.executor} / {item.provider} ({item.model})
            </span>
            {item.reason ? (
              <span className="font-medium text-destructive">{item.reason}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ApprovalWaitingIndicator({
  approvalInfo,
  className,
}: {
  approvalInfo?: { id: string; title: string; riskLevel?: "low" | "medium" | "high" } | null;
  className?: string;
}) {
  if (!approvalInfo) return null;

  return (
    <div
      data-testid="approval-waiting-indicator"
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold">
          <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Approval Gate 승인 대기 중</span>
        </div>
        {approvalInfo.riskLevel ? (
          <Badge variant="destructive" className="text-xs uppercase">
            {approvalInfo.riskLevel} Risk
          </Badge>
        ) : null}
      </div>
      <p className="text-muted-foreground">{approvalInfo.title}</p>
    </div>
  );
}

export function IncidentStateIndicator({
  incidentInfo,
  className,
}: {
  incidentInfo?: { code: string; title: string; status: "open" | "resolved" } | null;
  className?: string;
}) {
  if (!incidentInfo) return null;

  return (
    <div
      data-testid="incident-state-indicator"
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold">
          <Flame className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>SRE 인시던트 연관 감지</span>
        </div>
        <Badge variant="outline" className="border-destructive/30 text-xs">
          {incidentInfo.code}
        </Badge>
      </div>
      <p className="text-muted-foreground">{incidentInfo.title}</p>
    </div>
  );
}
