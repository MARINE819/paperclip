import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { JarvisCoreState } from "./neuralCommandTypes";

export interface NeuralSignalOverlayProps {
  jarvisState: JarvisCoreState;
  activeTeamName?: string | null;
  activeAgentName?: string | null;
  /**
   * Terminal execution telemetry: strictly populated ONLY from terminal runs
   * (succeeded / failed / timed_out) where real backend values exist.
   * NEVER used during active queued/running runs.
   */
  terminalExecutor?: string | null;
  terminalProvider?: string | null;
  terminalModel?: string | null;
  isReturnFlowActive?: boolean;
  className?: string;
}

/**
 * NeuralSignalOverlay:
 * Desktop-only SVG overlay that traces truthful signal pulses:
 * - Active forward flow: CEO -> JARVIS Core -> Team / Agent (truthful only; executor/provider/model are NOT speculated).
 * - Return flow (terminal succeeded / failed): Agent (with confirmed terminal executor/provider/model) -> JARVIS -> CEO.
 *
 * Rules:
 * 1. Strictly pointer-events-none: never intercepts clicks or touch events.
 * 2. Desktop-only (hidden md:block): zero footprint or layout shift on mobile viewports.
 * 3. Token-only styling: no raw hex or arbitrary Tailwind brackets.
 */
export function NeuralSignalOverlay({
  jarvisState,
  activeTeamName,
  activeAgentName,
  terminalExecutor,
  terminalProvider,
  terminalModel,
  isReturnFlowActive = false,
  className,
}: NeuralSignalOverlayProps) {
  const isWorking = jarvisState === "working";
  const isDispatching = jarvisState === "dispatching";
  const isApproval = jarvisState === "approval";
  const isError = jarvisState === "error";
  const isDone = jarvisState === "done" || isReturnFlowActive;

  // Active forward flow is ONLY for CEO -> JARVIS -> Team / Agent
  const hasActiveForwardFlow = isWorking || isDispatching;

  // Return flow is ONLY active when a terminal run has concluded
  const hasTerminalReturnFlow = isDone || isError;

  // Signal line stroke color by state
  const strokeClass = useMemo(() => {
    if (isError) return "stroke-destructive";
    if (isApproval) return "stroke-amber-500";
    if (isDone) return "stroke-emerald-500";
    if (isWorking) return "stroke-blue-500";
    if (isDispatching) return "stroke-indigo-500";
    return "stroke-border";
  }, [isError, isApproval, isDone, isWorking, isDispatching]);

  return (
    <div
      aria-hidden="true"
      data-testid="neural-signal-overlay"
      className={cn(
        "pointer-events-none absolute inset-0 z-0 hidden md:block overflow-hidden",
        className,
      )}
    >
      <svg
        className="h-full w-full opacity-40 transition-opacity duration-300"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="forward-signal-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" className="text-primary" stopColor="currentColor" stopOpacity="0.8" />
            <stop offset="100%" className="text-blue-500" stopColor="currentColor" stopOpacity="0.2" />
          </linearGradient>
          <linearGradient id="return-signal-grad" x1="100%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" className="text-emerald-500" stopColor="currentColor" stopOpacity="0.9" />
            <stop offset="100%" className="text-primary" stopColor="currentColor" stopOpacity="0.3" />
          </linearGradient>
        </defs>

        {/* 1. Forward Signal: CEO -> JARVIS Core -> Team / Agent (factual routing only, no speculative executor/model) */}
        {hasActiveForwardFlow ? (
          <path
            d="M 160,180 Q 240,240 380,240 T 700,300"
            fill="none"
            strokeWidth="2"
            strokeDasharray="4 4"
            className={cn(strokeClass, "animate-pulse")}
          />
        ) : null}

        {/* 2. Return Signal: Agent / Confirmed Terminal Executor -> JARVIS -> CEO (terminal runs only) */}
        {hasTerminalReturnFlow ? (
          <path
            d="M 700,320 Q 420,280 260,200 T 160,190"
            fill="none"
            stroke={isError ? "currentColor" : "url(#return-signal-grad)"}
            strokeWidth="3"
            strokeDasharray="6 6"
            className={cn("animate-pulse", isError && "text-destructive stroke-destructive")}
          />
        ) : null}
      </svg>
    </div>
  );
}
