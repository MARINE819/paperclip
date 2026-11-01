// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Issue, OrgUnitStatus } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import {
  computeRoomCapacity,
  deriveAgentBehavior,
  derivePixelAppearance,
} from "./officeLayoutEngine";
import { PixelAgentSprite } from "./PixelAgentSprite";
import { TopDownOfficeCanvas, type DepartmentRoomSpec } from "./TopDownOfficeCanvas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

const FIXED_ROOMS: ReadonlyArray<DepartmentRoomSpec> = [
  { label: "비서실", orgUnitName: "비서실" },
  { label: "개발팀", orgUnitName: "개발팀" },
  { label: "기획·전략팀", orgUnitName: "기획·전략팀" },
  { label: "QA팀", orgUnitName: "QA·품질팀" },
  { label: "영업팀", orgUnitName: null },
  { label: "회계·재무팀", orgUnitName: "재무·관리팀" },
  { label: "법무팀", orgUnitName: null },
  { label: "교육팀", orgUnitName: null },
];

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "강건",
    urlKey: "kang-geon",
    role: "general",
    title: "개발팀장",
    icon: null,
    status: "idle",
    reportsTo: null,
    orgUnitId: "org-dev",
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: new Date(),
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

function makeOrgUnit(overrides: Partial<OrgUnitStatus> = {}): OrgUnitStatus {
  return {
    orgUnitId: "org-dev",
    name: "개발팀",
    agentCount: 1,
    activeCount: 1,
    runningCount: 0,
    errorCount: 0,
    currentTaskCount: 0,
    ...overrides,
  };
}

describe("Top-Down 2D Pixel Office Engine & Canvas", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("derives all 9 real-time employee behaviors strictly from actual NEXORA data", () => {
    const now = Date.now();
    const baseAgent = makeAgent({ id: "a1", name: "강건", status: "idle", lastHeartbeatAt: new Date(now) });

    // 1. 대기 (idle)
    const idleRes = deriveAgentBehavior({
      agent: baseAgent,
      liveRun: undefined,
      hasPendingApproval: false,
      hasInReview: false,
      now,
    });
    expect(idleRes.behavior).toBe("idle");

    // 2. 업무 배정 (task-assigned)
    const assignedRes = deriveAgentBehavior({
      agent: baseAgent,
      liveRun: undefined,
      hasPendingApproval: false,
      hasInReview: false,
      now,
      allIssues: [{ id: "iss-1", title: "API 설계", status: "todo", assigneeAgentId: "a1", parentId: null } as Issue],
    });
    expect(assignedRes.behavior).toBe("task-assigned");

    // 3. 자리 이동 및 착석 (moving-to-seat when queued)
    const movingRes = deriveAgentBehavior({
      agent: baseAgent,
      liveRun: {
        id: "r1",
        status: "queued",
        invocationSource: "manual",
        triggerDetail: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-01-01",
        agentId: "a1",
        agentName: "강건",
        adapterType: "codex_local",
      },
      hasPendingApproval: false,
      hasInReview: false,
      now,
    });
    expect(movingRes.behavior).toBe("moving-to-seat");

    // 4. 실제 업무 중 타이핑 (working-typing)
    const typingRes = deriveAgentBehavior({
      agent: { ...baseAgent, status: "running" },
      liveRun: {
        id: "r2",
        status: "running",
        invocationSource: "manual",
        triggerDetail: "Implementing feature",
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-01-01",
        agentId: "a1",
        agentName: "강건",
        adapterType: "codex_local",
        currentToolName: "edit_file",
      },
      hasPendingApproval: false,
      hasInReview: false,
      now,
    });
    expect(typingRes.behavior).toBe("working-typing");

    // 5. 협업 및 회의 (collaborating via in-review or shared parent issue)
    const collabRes = deriveAgentBehavior({
      agent: baseAgent,
      liveRun: undefined,
      hasPendingApproval: false,
      hasInReview: true,
      now,
      allIssues: [
        { id: "iss-p", title: "Parent", status: "in_progress", assigneeAgentId: "jarvis-1", parentId: null } as Issue,
        { id: "iss-c", title: "Child", status: "in_review", assigneeAgentId: "a1", parentId: "iss-p" } as Issue,
      ],
    });
    expect(collabRes.behavior).toBe("collaborating");
    expect(collabRes.collaboratorIds).toContain("jarvis-1");

    // 6. CEO 승인 대기 (approval-waiting)
    const approvalRes = deriveAgentBehavior({
      agent: baseAgent,
      liveRun: undefined,
      hasPendingApproval: true,
      hasInReview: false,
      now,
    });
    expect(approvalRes.behavior).toBe("approval-waiting");

    // 7. 업무 완료 (task-completed)
    const completedRes = deriveAgentBehavior({
      agent: baseAgent,
      liveRun: undefined,
      hasPendingApproval: false,
      hasInReview: false,
      now,
      completedIssues: [{ id: "iss-done", title: "Done Task", status: "done", assigneeAgentId: "a1" } as Issue],
    });
    expect(completedRes.behavior).toBe("task-completed");

    // 8. 오류 및 차단 (blocked-error)
    const errorRes = deriveAgentBehavior({
      agent: { ...baseAgent, status: "error" },
      liveRun: undefined,
      hasPendingApproval: false,
      hasInReview: false,
      now,
    });
    expect(errorRes.behavior).toBe("blocked-error");

    // 9. 오프라인 (offline)
    const offlineRes = deriveAgentBehavior({
      agent: { ...baseAgent, status: "idle", lastHeartbeatAt: null },
      liveRun: undefined,
      hasPendingApproval: false,
      hasInReview: false,
      now,
    });
    expect(offlineRes.behavior).toBe("offline");
  });

  it("generates deterministic pixel appearance per employee ID and auto-scales room capacity", () => {
    const jarvisLook = derivePixelAppearance("136dfad5-78fa-4f56-a918-4eaa17ba2f20", "JARVIS", "CTO");
    const jarvisLookAgain = derivePixelAppearance("136dfad5-78fa-4f56-a918-4eaa17ba2f20", "JARVIS", "CTO");
    expect(jarvisLook).toEqual(jarvisLookAgain);
    expect(jarvisLook.rankBadge).toBe("crown");
    expect(jarvisLook.hasHeadset).toBe(true);

    const smallRoom = computeRoomCapacity(1, true);
    expect(smallRoom.isExpandedRoom).toBe(false);
    const expandedRoom = computeRoomCapacity(4, true);
    expect(expandedRoom.isExpandedRoom).toBe(true);
    expect(expandedRoom.totalDesks).toBe(5);
  });

  it("renders TopDownOfficeCanvas with all zones, zoom controls, collaboration banner, and JARVIS voice indicator", () => {
    const now = Date.now();
    const jarvis = makeAgent({ id: "jarvis-1", name: "JARVIS", role: "ceo", title: "CTO", orgUnitId: null });
    const kang = makeAgent({ id: "dev-1", name: "강건", title: "개발팀장", orgUnitId: "org-dev", status: "running" });
    const choi = makeAgent({ id: "dev-2", name: "최수아", title: "개발팀원", orgUnitId: "org-dev", status: "idle" });
    const oh = makeAgent({ id: "infra-1", name: "오승민", title: "운영·인프라팀장", orgUnitId: "org-infra", status: "idle" });

    const orgUnits = [
      makeOrgUnit({ orgUnitId: "org-sec", name: "비서실" }),
      makeOrgUnit({ orgUnitId: "org-dev", name: "개발팀", agentCount: 2 }),
      makeOrgUnit({ orgUnitId: "org-infra", name: "운영·인프라팀", agentCount: 1 }),
    ];
    const orgUnitIdByName = new Map(orgUnits.map((u) => [u.name, u.orgUnitId]));
    const liveRunByAgentId = new Map<string, LiveRunForIssue>([
      [
        "dev-1",
        {
          id: "run-10",
          status: "running",
          invocationSource: "manual",
          triggerDetail: "Implementing Top-Down Office",
          startedAt: null,
          finishedAt: null,
          createdAt: "2026-01-01",
          agentId: "dev-1",
          agentName: "강건",
          adapterType: "codex_local",
        },
      ],
    ]);

    const allIssues: Issue[] = [
      { id: "p-1", title: "Office Upgrade", status: "in_progress", assigneeAgentId: "jarvis-1", parentId: null } as Issue,
      { id: "c-1", title: "Dev Implementation", status: "in_progress", assigneeAgentId: "dev-1", parentId: "p-1" } as Issue,
    ];

    const root = createRoot(container);
    act(() => {
      root.render(
        <TopDownOfficeCanvas
          agents={[jarvis, kang, choi, oh]}
          orgUnits={orgUnits}
          departmentRooms={FIXED_ROOMS}
          secretariatRoom={FIXED_ROOMS[0]!}
          otherOrgUnits={[orgUnits[2]!]}
          jarvis={jarvis}
          atlas={undefined}
          liveRunByAgentId={liveRunByAgentId}
          pendingApprovalAgentIds={new Set()}
          inReviewAgentIds={new Set()}
          orgUnitIdByName={orgUnitIdByName}
          allIssues={allIssues}
          completedIssues={[]}
          pendingApprovalCount={2}
          voiceState="listening"
          now={now}
          onSelectAgent={vi.fn()}
          onSelectWorkspace={vi.fn()}
        />,
      );
    });

    // Verifies Top-Down floor, toolbar, and voice listening banner
    expect(container.querySelector('[data-testid="ai-office-topdown-floor"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="jarvis-voice-active-banner"]')?.textContent).toContain(
      "JARVIS 한국어 음성 수신 중",
    );
    expect(container.textContent).toContain("결재 대기 2건");

    // Verifies real collaboration banner between JARVIS and 강건
    const collabBanner = container.querySelector('[data-testid="office-collaboration-banner"]');
    expect(collabBanner).not.toBeNull();
    expect(collabBanner?.textContent).toContain("JARVIS");
    expect(collabBanner?.textContent).toContain("강건");

    // Verifies zoom controls work deterministically
    const zoomLevel = container.querySelector('[data-testid="office-zoom-level"]')!;
    expect(zoomLevel.textContent).toBe("100%");
    const zoomInBtn = container.querySelector('[data-testid="office-zoom-in-btn"]') as HTMLButtonElement;
    act(() => zoomInBtn.click());
    expect(zoomLevel.textContent).toBe("115%");
    const resetBtn = container.querySelector('[data-testid="office-zoom-reset-btn"]') as HTMLButtonElement;
    act(() => resetBtn.click());
    expect(zoomLevel.textContent).toBe("100%");

    // Verifies PixelAgentSprite renders zero text nodes inside the sprite itself
    const spriteContainer = document.createElement("div");
    const spriteRoot = createRoot(spriteContainer);
    act(() => {
      spriteRoot.render(<PixelAgentSprite name="강건" agentId="dev-1" state="working" behavior="working-typing" />);
    });
    expect(spriteContainer.textContent).toBe("");
    act(() => spriteRoot.unmount());

    act(() => root.unmount());
  });
});
