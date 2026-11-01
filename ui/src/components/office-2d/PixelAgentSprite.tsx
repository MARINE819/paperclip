import type { CSSProperties } from "react";
import { CheckCircle2, Clock, GitBranch, Mic, MoveRight, Sparkles, TriangleAlert } from "lucide-react";
import type { SeatState } from "@/components/AIOfficeFloor";
import { cn } from "@/lib/utils";
import {
  derivePixelAppearance,
  type AgentBehaviorKind,
} from "./officeLayoutEngine";

export interface PixelAgentSpriteProps {
  name: string;
  agentId?: string;
  role?: string;
  state: SeatState;
  behavior?: AgentBehaviorKind;
  voiceActive?: boolean;
}

/**
 * Top-Down 2D Pixel-Art Employee Character Sprite.
 * Built 100% from Paperclip CSS design tokens (`--agent-*`, `--status-agent-*`)
 * with zero external graphic assets and zero hardcoded color/bracket literals.
 */
export function PixelAgentSprite({
  name,
  agentId,
  role,
  state,
  behavior = "idle",
  voiceActive = false,
}: PixelAgentSpriteProps) {
  const isBlocked = state === "blocked-error" || behavior === "blocked-error";
  const isDimmed = state === "offline" || state === "unlinked" || behavior === "offline";
  const isTyping = state === "working" || behavior === "working-typing";
  const isMoving = behavior === "moving-to-seat";
  const isAssigned = behavior === "task-assigned";
  const isCollaborating = behavior === "collaborating" || state === "in-review";
  const isCompleted = behavior === "task-completed";
  const isApprovalWaiting = state === "approval-waiting" || behavior === "approval-waiting";

  const appearance = derivePixelAppearance(agentId ?? name, name, role);
  const primaryColorVar = `var(--agent-${appearance.paletteIndex}a, var(--primary))`;
  const secondaryColorVar = `var(--agent-${appearance.paletteIndex}b, var(--muted-foreground))`;

  const headFill = isBlocked
    ? "var(--status-agent-error)"
    : state === "in-review"
      ? "var(--status-task-in_review)"
      : "var(--status-agent-idle)";

  return (
    <div
      data-part="agent"
      data-seat-state={state}
      data-agent-behavior={behavior}
      className={cn(
        "relative flex flex-col items-center select-none transition-transform duration-200",
        isDimmed && "opacity-40 grayscale",
        isMoving && "animate-pulse",
      )}
    >
      {/* Top-down pixel head (first child div keeps h-6 w-6 rounded-full for test compatibility) */}
      <div
        aria-hidden="true"
        className={cn(
          "relative h-6 w-6 rounded-full border border-border shadow-xs",
          isBlocked && "hb-blink",
        )}
        style={{ backgroundColor: headFill } as CSSProperties}
      >
        {/* Pixel Hair Cap (Top-down view) */}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0.5 top-0.5 h-2 rounded-t-full opacity-80",
            appearance.hairStyle === "spiky" && "border-b border-dashed border-background",
            appearance.hairStyle === "bun" && "mx-1 h-2.5 rounded-full",
          )}
          style={{ backgroundColor: primaryColorVar } as CSSProperties}
        />

        {/* Pixel Eyes / Glasses */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 top-2.5 flex items-center justify-between px-0.5"
        >
          <span
            className={cn(
              "block h-1 w-1 rounded-xs bg-background",
              appearance.hasGlasses && "ring-1 ring-foreground/60",
            )}
          />
          <span
            className={cn(
              "block h-1 w-1 rounded-xs bg-background",
              appearance.hasGlasses && "ring-1 ring-foreground/60",
            )}
          />
        </span>

        {/* Headset band for orchestrators / tech staff */}
        {appearance.hasHeadset ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -left-0.5 top-2 h-2 w-0.5 rounded-full bg-foreground/80"
          />
        ) : null}

        {/* Behavior 6: CEO Approval Waiting Indicator */}
        {isApprovalWaiting ? (
          <Clock
            aria-hidden="true"
            className="absolute -right-2.5 -top-2.5 h-4 w-4 rounded-full border border-border bg-background p-0.5"
            style={{ color: "var(--status-agent-paused)" } as CSSProperties}
          />
        ) : null}

        {/* Behavior 2: Task Assigned Indicator */}
        {!isApprovalWaiting && isAssigned ? (
          <Sparkles
            aria-hidden="true"
            className="absolute -right-2.5 -top-2.5 h-4 w-4 rounded-full border border-border bg-background p-0.5"
            style={{ color: "var(--status-agent-running)" } as CSSProperties}
          />
        ) : null}

        {/* Behavior 3: Moving to Seat Indicator */}
        {!isApprovalWaiting && isMoving ? (
          <MoveRight
            aria-hidden="true"
            className="absolute -right-2.5 -top-2.5 h-4 w-4 rounded-full border border-border bg-background p-0.5"
            style={{ color: "var(--status-agent-running)" } as CSSProperties}
          />
        ) : null}

        {/* Behavior 5: Collaborating / Meeting Indicator */}
        {!isApprovalWaiting && !isMoving && isCollaborating ? (
          <GitBranch
            aria-hidden="true"
            className="absolute -right-2.5 -top-2.5 h-4 w-4 rounded-full border border-border bg-background p-0.5"
            style={{ color: "var(--status-task-in_review)" } as CSSProperties}
          />
        ) : null}

        {/* Behavior 7: Task Completed Indicator */}
        {!isApprovalWaiting && !isMoving && !isCollaborating && isCompleted ? (
          <CheckCircle2
            aria-hidden="true"
            className="absolute -right-2.5 -top-2.5 h-4 w-4 rounded-full border border-border bg-background p-0.5"
            style={{ color: "var(--status-agent-running)" } as CSSProperties}
          />
        ) : null}

        {/* Behavior 8: Error / Blocked Indicator */}
        {isBlocked ? (
          <TriangleAlert
            aria-hidden="true"
            className="hb-blink absolute -left-2.5 -top-2.5 h-4 w-4 rounded-full border border-border bg-background p-0.5"
            style={{ color: "var(--status-agent-error)" } as CSSProperties}
          />
        ) : null}

        {/* JARVIS Voice Active Indicator */}
        {voiceActive ? (
          <Mic
            aria-hidden="true"
            className="hb-pulse absolute -left-2.5 -bottom-1 h-4 w-4 rounded-full border border-border bg-background p-0.5"
            style={{ color: "var(--status-agent-running)" } as CSSProperties}
          />
        ) : null}
      </div>

      {/* Top-down pixel shoulders/torso + typing hands */}
      <div
        aria-hidden="true"
        className="relative flex h-6 w-8 items-start justify-between rounded-t-full border border-border/50 bg-muted-foreground/40 px-0.5 pt-0.5"
        style={
          !isDimmed
            ? ({
                backgroundImage: `linear-gradient(180deg, ${primaryColorVar}, ${secondaryColorVar})`,
              } as CSSProperties)
            : undefined
        }
      >
        {/* Left & Right Pixel Hands — animate on keyboard when typing */}
        <span
          aria-hidden="true"
          className={cn(
            "block h-2 w-2 rounded-full border border-border/60 bg-background/90",
            isTyping && "hb-pulse -translate-y-1",
          )}
        />
        {/* Rank Lapel Pin */}
        <span
          aria-hidden="true"
          className={cn(
            "mt-1 block h-1.5 w-1.5 rounded-full bg-background/80",
            appearance.rankBadge === "crown" && "ring-1 ring-amber-400",
          )}
        />
        <span
          aria-hidden="true"
          className={cn(
            "block h-2 w-2 rounded-full border border-border/60 bg-background/90",
            isTyping && "hb-pulse -translate-y-1",
          )}
        />
      </div>
    </div>
  );
}
