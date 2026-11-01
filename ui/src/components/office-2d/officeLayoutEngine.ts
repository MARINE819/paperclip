import type { Agent, Issue, OrgUnitStatus } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { computeSeatState, type SeatState } from "@/components/AIOfficeFloor";

/**
 * 9 Real-Time AI Employee Behavior States in the Top-Down 2D Pixel Office.
 * Every behavior is deterministically derived from actual NEXORA data
 * (agent status, liveRuns, issues/delegation, approvals) — never fabricated.
 */
export type AgentBehaviorKind =
  | "idle"              // 1. 대기
  | "task-assigned"     // 2. 업무 배정
  | "moving-to-seat"    // 3. 자리 이동 및 착석
  | "working-typing"    // 4. 실제 업무 중 타이핑
  | "collaborating"     // 5. 협업 및 회의
  | "approval-waiting"  // 6. CEO 승인 대기
  | "task-completed"    // 7. 업무 완료
  | "blocked-error"     // 8. 오류 및 차단
  | "offline";          // 9. 오프라인

export const AGENT_BEHAVIOR_LABEL: Record<AgentBehaviorKind, string> = {
  idle: "대기",
  "task-assigned": "업무 배정",
  "moving-to-seat": "착석 이동",
  "working-typing": "타이핑 작업 중",
  collaborating: "협업·회의 중",
  "approval-waiting": "CEO 승인 대기",
  "task-completed": "업무 완료",
  "blocked-error": "오류·차단",
  offline: "오프라인",
};

export interface AgentBehaviorState {
  agentId: string;
  seatState: SeatState;
  behavior: AgentBehaviorKind;
  behaviorLabel: string;
  collaboratorIds: string[];
  activeIssueTitle: string | null;
  delegatedFromId: string | null;
}

export interface DeriveBehaviorInput {
  agent: Pick<Agent, "id" | "name" | "status" | "lastHeartbeatAt" | "reportsTo">;
  liveRun: LiveRunForIssue | undefined;
  hasPendingApproval: boolean;
  hasInReview: boolean;
  now: number;
  allIssues?: Issue[];
  completedIssues?: Issue[];
}

/**
 * Pure, deterministic derivation of an AI employee's 2D office behavior from real NEXORA state.
 * Never fabricates work or movement when no real backing record exists.
 */
export function deriveAgentBehavior(input: DeriveBehaviorInput): AgentBehaviorState {
  const {
    agent,
    liveRun,
    hasPendingApproval,
    hasInReview,
    now,
    allIssues = [],
    completedIssues = [],
  } = input;

  const seatState = computeSeatState(agent, Boolean(liveRun), hasPendingApproval, now, hasInReview);

  // Find active issues assigned to this agent
  const assignedIssues = allIssues.filter((issue) => issue.assigneeAgentId === agent.id);
  const activeIssue = assignedIssues.find(
    (issue) => issue.status === "in_progress" || issue.status === "in_review" || issue.status === "todo",
  );

  // Detect real collaboration: shared parent issue with another assigned agent, or in_review handoff
  const collaboratorIdSet = new Set<string>();
  let delegatedFromId: string | null = null;

  for (const issue of assignedIssues) {
    if (issue.parentId && (issue.status === "in_progress" || issue.status === "in_review" || issue.status === "todo")) {
      const parentIssue = allIssues.find((candidate) => candidate.id === issue.parentId);
      if (parentIssue?.assigneeAgentId && parentIssue.assigneeAgentId !== agent.id) {
        collaboratorIdSet.add(parentIssue.assigneeAgentId);
        delegatedFromId = parentIssue.assigneeAgentId;
      }
      for (const sibling of allIssues) {
        if (
          sibling.parentId === issue.parentId &&
          sibling.assigneeAgentId &&
          sibling.assigneeAgentId !== agent.id &&
          (sibling.status === "in_progress" || sibling.status === "in_review")
        ) {
          collaboratorIdSet.add(sibling.assigneeAgentId);
        }
      }
    }
  }

  // Also check if this agent is a parent orchestrator of active child issues
  for (const issue of allIssues) {
    if (
      issue.parentId &&
      (issue.status === "in_progress" || issue.status === "in_review") &&
      issue.assigneeAgentId &&
      issue.assigneeAgentId !== agent.id
    ) {
      const parent = allIssues.find((p) => p.id === issue.parentId);
      if (parent?.assigneeAgentId === agent.id) {
        collaboratorIdSet.add(issue.assigneeAgentId);
      }
    }
  }

  const collaboratorIds = [...collaboratorIdSet];
  const activeIssueTitle =
    liveRun?.currentStatusMessage ??
    liveRun?.triggerDetail ??
    activeIssue?.title ??
    null;

  // Priority 1: Blocked / Error (8. 오류 및 차단)
  if (seatState === "blocked-error") {
    return {
      agentId: agent.id,
      seatState,
      behavior: "blocked-error",
      behaviorLabel: AGENT_BEHAVIOR_LABEL["blocked-error"],
      collaboratorIds,
      activeIssueTitle,
      delegatedFromId,
    };
  }

  // Priority 2: CEO Approval Waiting (6. CEO 승인 대기)
  if (seatState === "approval-waiting") {
    return {
      agentId: agent.id,
      seatState,
      behavior: "approval-waiting",
      behaviorLabel: AGENT_BEHAVIOR_LABEL["approval-waiting"],
      collaboratorIds,
      activeIssueTitle,
      delegatedFromId,
    };
  }

  // Priority 3: Active LiveRun or Running status
  if (seatState === "working") {
    const runStatus = liveRun?.status;
    // 3. 자리 이동 및 착석 when run is just queued/starting
    if (runStatus === "queued") {
      return {
        agentId: agent.id,
        seatState,
        behavior: "moving-to-seat",
        behaviorLabel: AGENT_BEHAVIOR_LABEL["moving-to-seat"],
        collaboratorIds,
        activeIssueTitle,
        delegatedFromId,
      };
    }
    // 5. 협업 및 회의 when actively working with real collaborators on a shared parent/child chain
    if (collaboratorIds.length > 0 && !liveRun?.currentToolName) {
      return {
        agentId: agent.id,
        seatState,
        behavior: "collaborating",
        behaviorLabel: AGENT_BEHAVIOR_LABEL.collaborating,
        collaboratorIds,
        activeIssueTitle,
        delegatedFromId,
      };
    }
    // 4. 실제 업무 중 타이핑
    return {
      agentId: agent.id,
      seatState,
      behavior: "working-typing",
      behaviorLabel: AGENT_BEHAVIOR_LABEL["working-typing"],
      collaboratorIds,
      activeIssueTitle,
      delegatedFromId,
    };
  }

  // Priority 4: In-Review (5. 협업 및 회의 / 검토)
  if (seatState === "in-review") {
    return {
      agentId: agent.id,
      seatState,
      behavior: "collaborating",
      behaviorLabel: AGENT_BEHAVIOR_LABEL.collaborating,
      collaboratorIds,
      activeIssueTitle,
      delegatedFromId,
    };
  }

  // Priority 5: Offline (9. 오프라인)
  if (seatState === "offline" || seatState === "unlinked") {
    return {
      agentId: agent.id,
      seatState,
      behavior: "offline",
      behaviorLabel: AGENT_BEHAVIOR_LABEL.offline,
      collaboratorIds: [],
      activeIssueTitle: null,
      delegatedFromId: null,
    };
  }

  // Priority 6: Task Assigned (2. 업무 배정) — idle agent with an assigned todo/in_progress issue
  const hasAssignedTodo = assignedIssues.some(
    (issue) => issue.status === "todo" || issue.status === "in_progress",
  );
  if (hasAssignedTodo) {
    return {
      agentId: agent.id,
      seatState,
      behavior: "task-assigned",
      behaviorLabel: AGENT_BEHAVIOR_LABEL["task-assigned"],
      collaboratorIds,
      activeIssueTitle: activeIssue?.title ?? null,
      delegatedFromId,
    };
  }

  // Priority 7: Recently Completed Task (7. 업무 완료) — idle agent who has a completed issue in the recent list
  const hasRecentCompleted = completedIssues.some((issue) => issue.assigneeAgentId === agent.id);
  if (hasRecentCompleted) {
    return {
      agentId: agent.id,
      seatState,
      behavior: "task-completed",
      behaviorLabel: AGENT_BEHAVIOR_LABEL["task-completed"],
      collaboratorIds: [],
      activeIssueTitle: null,
      delegatedFromId: null,
    };
  }

  // Priority 8: Default Idle (1. 대기)
  return {
    agentId: agent.id,
    seatState,
    behavior: "idle",
    behaviorLabel: AGENT_BEHAVIOR_LABEL.idle,
    collaboratorIds: [],
    activeIssueTitle: null,
    delegatedFromId: null,
  };
}

/**
 * Deterministic 2D pixel character appearance traits derived from `agentId` + `name`.
 * Ensures every registered AI employee (and any newly hired future employee) gets a
 * distinct, consistent top-down pixel look using only Paperclip `--agent-*` CSS variables.
 */
export interface PixelAppearance {
  paletteIndex: number; // 1..10 -> maps to var(--agent-1a) / var(--agent-1b)
  hairStyle: "short" | "parted" | "bun" | "spiky";
  hasGlasses: boolean;
  hasHeadset: boolean;
  rankBadge: "crown" | "star" | "shield" | "dot";
}

export function derivePixelAppearance(agentId: string, name: string, role?: string | null): PixelAppearance {
  let hash = 0;
  const seed = `${agentId}:${name}`;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }

  const paletteIndex = (hash % 10) + 1;
  const hairStyles: PixelAppearance["hairStyle"][] = ["short", "parted", "bun", "spiky"];
  const hairStyle = hairStyles[(hash >>> 3) % hairStyles.length]!;
  const hasGlasses = ((hash >>> 5) & 1) === 1;
  const hasHeadset = name === "JARVIS" || name === "Atlas" || ((hash >>> 7) & 1) === 1;

  const normalizedRole = (role ?? "").toLowerCase();
  const rankBadge: PixelAppearance["rankBadge"] =
    name === "JARVIS" || name === "Atlas" || normalizedRole.includes("ceo") || normalizedRole.includes("cto") || normalizedRole.includes("coo")
      ? "crown"
      : normalizedRole.includes("팀장") || normalizedRole.includes("실장")
        ? "star"
        : normalizedRole.includes("보안") || normalizedRole.includes("감사")
          ? "shield"
          : "dot";

  return {
    paletteIndex,
    hairStyle,
    hasGlasses,
    hasHeadset,
    rankBadge,
  };
}

/**
 * Room auto-scaling and seat allocation helper for dynamic hiring & department expansion.
 */
export interface RoomCapacityPlan {
  assignedCount: number;
  emptyDeskSlots: number;
  totalDesks: number;
  isExpandedRoom: boolean;
}

export function computeRoomCapacity(assignedCount: number, isStaffedOrgUnit: boolean): RoomCapacityPlan {
  if (!isStaffedOrgUnit && assignedCount === 0) {
    return {
      assignedCount: 0,
      emptyDeskSlots: 1,
      totalDesks: 1,
      isExpandedRoom: false,
    };
  }
  // Always keep 1 spare desk slot in active rooms for immediate visual readiness on new hires,
  // and mark rooms with >= 3 employees as auto-expanded.
  const emptyDeskSlots = assignedCount === 0 ? 1 : 1;
  const totalDesks = Math.max(2, assignedCount + emptyDeskSlots);
  return {
    assignedCount,
    emptyDeskSlots,
    totalDesks,
    isExpandedRoom: assignedCount >= 3,
  };
}

export interface OfficeZoneSummary {
  totalRooms: number;
  activeDepartmentCount: number;
  expansionDepartmentCount: number;
  collaboratingAgentIds: string[];
}

export function summarizeOfficeZones(
  fixedRoomCount: number,
  otherOrgUnits: OrgUnitStatus[],
  behaviors: Map<string, AgentBehaviorState>,
): OfficeZoneSummary {
  const collaboratingAgentIds: string[] = [];
  for (const [agentId, state] of behaviors.entries()) {
    if (state.behavior === "collaborating" && state.collaboratorIds.length > 0) {
      collaboratingAgentIds.push(agentId);
    }
  }
  return {
    totalRooms: fixedRoomCount + otherOrgUnits.length,
    activeDepartmentCount: fixedRoomCount,
    expansionDepartmentCount: otherOrgUnits.length,
    collaboratingAgentIds,
  };
}
