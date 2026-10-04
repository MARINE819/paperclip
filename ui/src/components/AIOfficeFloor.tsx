import type { CSSProperties } from "react";
import { Clock, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { buttonVariants } from "@/components/ui/button";
import { deriveAgentCondition } from "@/components/AIOfficeControlTower";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { evalsApi, type EvalRunStatus } from "@/api/evals";
import { cn } from "@/lib/utils";

/**
 * Presentational layer for the AI Office 2D floor — every visual state here
 * is a pure function of already-fetched data (agent status, live-run
 * presence, pending-approval membership). Nothing in this file makes a
 * network call or invents a status that isn't backed by real data.
 */

export type SeatState = "working" | "idle" | "approval-waiting" | "blocked-error" | "offline" | "unlinked";

const SEAT_STATE_LABEL: Record<SeatState, string> = {
  working: "업무 중",
  idle: "대기",
  "approval-waiting": "승인 대기",
  "blocked-error": "오류/차단",
  offline: "오프라인",
  unlinked: "미연결",
};

// Reuses the repo's existing `--status-agent-*` design tokens via the same
// `.status-chip` + `--sc` recipe StatusBadge.tsx uses, so seat colors match
// the rest of Paperclip instead of inventing a new palette.
const SEAT_STATE_VAR: Record<SeatState, string> = {
  working: "--status-agent-running",
  idle: "--status-agent-idle",
  "approval-waiting": "--status-agent-paused",
  "blocked-error": "--status-agent-error",
  offline: "--status-task-cancelled",
  unlinked: "--status-task-cancelled",
};

export function computeSeatState(
  agent: Pick<Agent, "status" | "lastHeartbeatAt">,
  hasLiveRun: boolean,
  hasPendingApproval: boolean,
  now: number,
): SeatState {
  const condition = deriveAgentCondition(agent, hasLiveRun, now);
  if (condition === "error") return "blocked-error";
  if (hasPendingApproval) return "approval-waiting";
  if (hasLiveRun) return "working";
  if (condition === "offline") return "offline";
  return "idle";
}

export function SeatBadge({ state }: { state: SeatState }) {
  return (
    <span
      className="status-chip inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap"
      style={{ "--sc": `var(${SEAT_STATE_VAR[state]})` } as CSSProperties}
    >
      {SEAT_STATE_LABEL[state]}
    </span>
  );
}

/**
 * The employee only — head + body, built entirely from CSS shapes (no
 * photo, no external asset). This is deliberately just the person; the
 * surrounding desk/monitor/chair scene is composed by `Workstation` so this
 * piece stays independently testable and reusable (e.g. for a future
 * roster view that has no desk at all).
 */
export function MiniAgentFigure({ state }: { state: SeatState }) {
  const isBlocked = state === "blocked-error";
  const isDimmed = state === "offline" || state === "unlinked";

  return (
    <div
      data-part="agent"
      data-seat-state={state}
      className={cn("flex flex-col items-center", isDimmed && "opacity-40 grayscale")}
    >
      <div
        aria-hidden="true"
        className={cn("relative h-6 w-6 rounded-full border border-border", isBlocked && "hb-blink")}
        style={{
          backgroundColor: isBlocked ? "var(--status-agent-error)" : "var(--status-agent-idle)",
        }}
      >
        {state === "approval-waiting" ? (
          <Clock
            aria-hidden="true"
            className="absolute -right-2.5 -top-2.5 h-4 w-4 rounded-full border border-border bg-background p-0.5"
            style={{ color: "var(--status-agent-paused)" }}
          />
        ) : null}
      </div>
      <div aria-hidden="true" className="h-6 w-8 rounded-t-full bg-muted-foreground/40" />
    </div>
  );
}

/** A department/leadership Room — a floor area, not a card. */
export function RoomBox({
  label,
  icon: Icon,
  muted,
  children,
}: {
  label: string;
  icon: LucideIcon;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-room-type="department"
      className={cn(
        "flex min-h-32 flex-col gap-2 rounded-md border border-border/40 bg-muted/10 p-3",
        muted && "border-dashed bg-transparent opacity-70",
      )}
    >
      <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="flex flex-1 flex-wrap content-start items-end gap-3">{children}</div>
    </div>
  );
}

/**
 * A decoration/facility tile (meeting room, lounge, plants) — deliberately
 * has NO department-style header (icon + name row), so it can never be
 * mistaken for an org Room. `label` is optional and, when present, renders
 * as a small caption below the icon rather than a room title.
 */
export function AmenityTile({ icon: Icon, label }: { icon: LucideIcon; label?: string }) {
  return (
    <div
      data-room-type="amenity"
      className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-muted/10 p-3"
    >
      <Icon className="h-5 w-5 text-muted-foreground/70" aria-hidden="true" />
      {label ? <span className="text-[10px] text-muted-foreground">{label}</span> : null}
    </div>
  );
}

export interface WorkstationProps {
  name: string;
  role: string;
  liveRun: LiveRunForIssue | undefined;
  state: SeatState;
  onClick: () => void;
}

/**
 * A real, staffed workstation — monitor + stand + desk + employee + chair,
 * stacked directly on the Room's floor. Deliberately NO surrounding card
 * border/background: the desk surface itself is the only visual boundary,
 * so a row of these reads as "people at desks on a floor", not "a grid of
 * cards". Click opens the (data-only) detail Sheet.
 */
export function Workstation({ name, role: _role, liveRun: _liveRun, state, onClick }: WorkstationProps) {
  const isDimmed = state === "offline" || state === "unlinked";
  const isMonitorOn = state === "working";
  const isBlocked = state === "blocked-error";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-36 flex-col items-center gap-0 bg-transparent text-[10px] leading-tight",
        isDimmed && "opacity-40 grayscale",
      )}
    >
      <div className="relative flex flex-col items-center">
        <div
          data-part="monitor"
          aria-hidden="true"
          className={cn(
            "h-6 w-10 rounded-[4px] border border-border",
            isMonitorOn && "hb-pulse border-transparent",
          )}
          style={isMonitorOn ? { backgroundColor: "var(--status-agent-running)" } : undefined}
        />
        {isBlocked ? (
          <TriangleAlert
            aria-hidden="true"
            className="hb-blink absolute -right-3 -top-2 h-5 w-5"
            style={{ color: "var(--status-agent-error)" }}
          />
        ) : null}
      </div>
      <div data-part="monitor-stand" aria-hidden="true" className="h-1.5 w-1.5 bg-border" />
      <div data-part="desk" aria-hidden="true" className="h-2 w-28 rounded-sm bg-muted-foreground/50" />
      <MiniAgentFigure state={state} />
      <div data-part="chair" aria-hidden="true" className="-mt-1 h-3 w-14 rounded-b-full bg-border/70" />
      <span className="mt-1.5 w-full truncate text-center font-medium">{name}</span>
      <SeatBadge state={state} />
    </button>
  );
}

/** A room that exists but currently has no assigned/matched staff. */
export function EmptyRoomNote({ note }: { note: string }) {
  return (
    <div className="flex w-36 flex-col items-center gap-1 text-center text-[10px] opacity-60">
      <SeatBadge state="unlinked" />
      <span className="text-muted-foreground">{note}</span>
    </div>
  );
}

/**
 * A specific named leadership seat with nobody in it (JARVIS not found,
 * Atlas not yet created) — the same desk/chair shapes as a real Workstation,
 * minus the employee and a lit monitor, so it reads as "this desk is
 * vacant" rather than "a missing org card".
 */
export function EmptySeat({ caption }: { caption: string }) {
  return (
    <div className="flex w-36 flex-col items-center gap-0 text-[10px] leading-tight opacity-50">
      <div data-part="monitor" aria-hidden="true" className="h-6 w-10 rounded-[4px] border border-dashed border-border" />
      <div data-part="monitor-stand" aria-hidden="true" className="h-1.5 w-1.5 bg-border/70" />
      <div data-part="desk" aria-hidden="true" className="h-2 w-28 rounded-sm bg-muted-foreground/30" />
      <div data-part="chair" aria-hidden="true" className="mt-1 h-3 w-14 rounded-b-full border border-dashed border-border" />
      <SeatBadge state="unlinked" />
      <span className="mt-1.5 w-full truncate text-center text-muted-foreground">{caption}</span>
    </div>
  );
}

export interface AgentDetailInfo {
  agentId: string;
  name: string;
  role: string;
  state: SeatState;
  /** null when there is no active task — the row is omitted entirely rather
   * than rendered as an empty dash. A one-line summary is as much task detail
   * as AI Office shows; the full picture lives on the Dashboard-owned page. */
  taskSummary: string | null;
}

function AgentEvalBadge({ status }: { status: EvalRunStatus }) {
  const styles: Record<EvalRunStatus, { label: string; className: string }> = {
    passed: {
      label: "통과",
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    },
    failed: {
      label: "실패",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    },
    error: {
      label: "오류",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    },
    judged_only: {
      label: "판정 전용 (검증 미완료)",
      className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
    running: {
      label: "실행 중",
      className: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
    },
    queued: {
      label: "대기",
      className: "border-border bg-muted text-muted-foreground",
    },
  };
  const current = styles[status] ?? {
    label: status,
    className: "border-border bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        current.className,
      )}
    >
      {current.label}
    </span>
  );
}

function AgentEvalSectionContent({ agentId }: { agentId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["evals", "agent-summary", agentId],
    queryFn: () => evalsApi.getAgentSummary(agentId),
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="rounded-md border p-3 text-xs text-muted-foreground">
        Eval 데이터 로딩 중...
      </div>
    );
  }

  if (isError || !data?.agent) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
        Eval 데이터 조회 불가
      </div>
    );
  }

  const { latestEval, passRate, avgLatencyMs, avgCost, recentRegression } = data.agent;

  if (latestEval === null && passRate === null) {
    return (
      <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
        평가 데이터 없음 (아직 실행된 Eval이 없습니다)
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="text-xs font-semibold text-muted-foreground">
        F-04 품질 평가 (Agent Eval)
      </div>

      {/* 최근 Eval */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">최근 Eval</span>
        <div className="flex items-center gap-1.5">
          {latestEval ? (
            <>
              <span className="font-medium">
                {latestEval.benchmarkKey} (v{latestEval.benchmarkVersion})
              </span>
              <AgentEvalBadge status={latestEval.status} />
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </div>

      {/* 성공률 */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">성공률</span>
        <span className="font-medium">
          {passRate != null ? `${(passRate * 100).toFixed(1)}%` : "—"}
        </span>
      </div>

      {/* 평균 Latency */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">평균 Latency</span>
        <span className="font-medium">
          {avgLatencyMs != null ? `${Math.round(avgLatencyMs)}ms` : "—"}
        </span>
      </div>

      {/* 평균 Cost */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">평균 Cost</span>
        <span className="font-medium">
          {avgCost != null ? `$${avgCost.toFixed(4)}` : "—"}
        </span>
      </div>

      {/* 최근 Regression */}
      <div className="flex flex-col gap-1 border-t pt-1.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">최근 회귀 상태</span>
          {recentRegression && recentRegression.findings.length > 0 ? (
            <span className="rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
              회귀 감지 ({recentRegression.findings.length}건)
            </span>
          ) : (
            <span className="text-muted-foreground">회귀 없음 (정상)</span>
          )}
        </div>
        {recentRegression && recentRegression.findings.length > 0 ? (
          <div className="space-y-1 rounded bg-destructive/5 p-1.5 text-xs text-destructive">
            {recentRegression.findings.map((f, i) => (
              <div key={i}>• {f.message}</div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentEvalSection({ agentId }: { agentId: string }) {
  let hasClient = false;
  try {
    useQueryClient();
    hasClient = true;
  } catch {
    hasClient = false;
  }
  if (!hasClient) return null;
  return <AgentEvalSectionContent agentId={agentId} />;
}

/**
 * Workstation click detail — AI Office shows identity/role/seat state
 * and server-computed F-04 Agent Eval quality metrics, linking out to
 * Dashboard for full task/approval operational detail.
 */
export function AgentDetailSheet({
  agent,
  onOpenChange,
}: {
  agent: AgentDetailInfo | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={agent !== null} onOpenChange={onOpenChange}>
      <SheetContent>
        {agent ? (
          <>
            <SheetHeader>
              <SheetTitle>{agent.name}</SheetTitle>
              <SheetDescription>{agent.role}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-3 px-4 pb-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">현재 상태</span>
                <SeatBadge state={agent.state} />
              </div>
              {agent.taskSummary ? (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">현재 업무</span>
                  <span className="truncate">{agent.taskSummary}</span>
                </div>
              ) : null}

              {/* F-04 Agent Eval Quality Section */}
              <AgentEvalSection agentId={agent.agentId} />

              {/* Plain, company-prefix-unaware href on purpose — this file stays a
                  pure presentational layer with no Router/Company context
                  dependency. `/agents/:id` (unprefixed) resolves to the right
                  company via `UnprefixedBoardRedirect` in App.tsx. */}
              <a href={`/agents/${agent.agentId}`} className={buttonVariants({ variant: "outline", size: "sm", className: "w-fit" })}>
                Dashboard에서 상세 보기 →
              </a>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
