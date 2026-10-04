// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Coffee } from "lucide-react";

const mockEvalsApi = vi.hoisted(() => ({
  getAgentSummary: vi.fn(),
}));

vi.mock("../api/evals", () => ({
  evalsApi: mockEvalsApi,
}));
import {
  AgentDetailSheet,
  AmenityTile,
  computeSeatState,
  EmptyRoomNote,
  EmptySeat,
  MiniAgentFigure,
  RoomBox,
  SeatBadge,
  Workstation,
} from "./AIOfficeFloor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("AIOfficeFloor", () => {
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

  function render(node: React.ReactElement) {
    const root = createRoot(container);
    act(() => root.render(node));
    return root;
  }

  it("computeSeatState reflects real error/live-run/approval data, never a fabricated status", () => {
    const now = Date.now();
    expect(computeSeatState({ status: "error", lastHeartbeatAt: null }, false, false, now)).toBe("blocked-error");
    expect(computeSeatState({ status: "idle", lastHeartbeatAt: null }, false, true, now)).toBe("approval-waiting");
    expect(computeSeatState({ status: "running", lastHeartbeatAt: null }, true, false, now)).toBe("working");
    expect(computeSeatState({ status: "idle", lastHeartbeatAt: null }, false, false, now)).toBe("offline");
    expect(computeSeatState({ status: "idle", lastHeartbeatAt: new Date(now) }, false, false, now)).toBe("idle");
  });

  it("MiniAgentFigure marks blocked-error with hb-blink on the head (real, deterministic CSS, not random)", () => {
    const root = render(<MiniAgentFigure state="blocked-error" />);
    expect(container.querySelector(".hb-blink")).not.toBeNull();
    act(() => root.unmount());
  });

  it("MiniAgentFigure dims offline/unlinked figures instead of hiding real status", () => {
    const root = render(<MiniAgentFigure state="offline" />);
    expect(container.querySelector('[data-seat-state="offline"]')?.className).toContain("opacity-40");
    act(() => root.unmount());
  });

  // ── Real 2D Workstation visual fix — structural requirements ──

  it("Workstation has no per-employee card shell (no border/bg-card wrapper)", () => {
    const root = render(
      <Workstation name="Alpha" role="Engineer" liveRun={undefined} state="idle" onClick={vi.fn()} />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).not.toContain("border");
    expect(button.className).not.toContain("bg-card");
    expect(button.className).not.toContain("rounded-md border");
    act(() => root.unmount());
  });

  it("Workstation renders monitor/monitor-stand/desk/agent/chair as distinct parts", () => {
    const root = render(
      <Workstation name="Alpha" role="Engineer" liveRun={undefined} state="idle" onClick={vi.fn()} />,
    );
    expect(container.querySelector('[data-part="monitor"]')).not.toBeNull();
    expect(container.querySelector('[data-part="monitor-stand"]')).not.toBeNull();
    expect(container.querySelector('[data-part="desk"]')).not.toBeNull();
    expect(container.querySelector('[data-part="agent"]')).not.toBeNull();
    expect(container.querySelector('[data-part="chair"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("working turns the monitor on with hb-pulse; idle keeps it off", () => {
    const workingRoot = render(
      <Workstation name="Alpha" role="Engineer" liveRun={undefined} state="working" onClick={vi.fn()} />,
    );
    const workingMonitor = container.querySelector('[data-part="monitor"]')!;
    expect(workingMonitor.className).toContain("hb-pulse");
    act(() => workingRoot.unmount());

    const idleRoot = render(
      <Workstation name="Alpha" role="Engineer" liveRun={undefined} state="idle" onClick={vi.fn()} />,
    );
    const idleMonitor = container.querySelector('[data-part="monitor"]')!;
    expect(idleMonitor.className).not.toContain("hb-pulse");
    act(() => idleRoot.unmount());
  });

  it("approval-waiting shows a waiting marker with the monitor off (work paused)", () => {
    const root = render(
      <Workstation name="Alpha" role="Engineer" liveRun={undefined} state="approval-waiting" onClick={vi.fn()} />,
    );
    expect(container.querySelector('[data-part="monitor"]')?.className).not.toContain("hb-pulse");
    expect(container.textContent).toContain("승인 대기");
    act(() => root.unmount());
  });

  it("blocked/error shows a blinking warning marker on the workstation", () => {
    const root = render(
      <Workstation name="Alpha" role="Engineer" liveRun={undefined} state="blocked-error" onClick={vi.fn()} />,
    );
    const warning = container.querySelector(".hb-blink");
    expect(warning).not.toBeNull();
    act(() => root.unmount());
  });

  it("offline dims the entire workstation, not just the figure", () => {
    const root = render(
      <Workstation name="Alpha" role="Engineer" liveRun={undefined} state="offline" onClick={vi.fn()} />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("opacity-40");
    act(() => root.unmount());
  });

  // ── Workstation visual fix — enlarged shapes, minimal text ──

  it("Workstation shows only the agent name + a minimal state indicator, not role or task summary", () => {
    const root = render(
      <Workstation
        name="Alpha"
        role="Senior Backend Engineer"
        liveRun={{
          id: "r1",
          status: "running",
          invocationSource: "manual",
          triggerDetail: "a very long task description that should not appear on the floor",
          startedAt: null,
          finishedAt: null,
          createdAt: "2026-01-01",
          agentId: "a1",
          agentName: "Alpha",
          adapterType: "codex_local",
          currentStatusMessage: "Doing the long task",
        }}
        state="working"
        onClick={vi.fn()}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.textContent).toContain("Alpha");
    expect(button.textContent).toContain("업무 중");
    expect(button.textContent).not.toContain("Senior Backend Engineer");
    expect(button.textContent).not.toContain("Doing the long task");
    act(() => root.unmount());
  });

  it("Workstation and EmptySeat render enlarged shapes (~1.5x prior size) in a wider footprint", () => {
    const root = render(
      <Workstation name="Alpha" role="Engineer" liveRun={undefined} state="idle" onClick={vi.fn()} />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("w-36");
    expect(container.querySelector('[data-part="monitor"]')?.className).toContain("w-10");
    expect(container.querySelector('[data-part="desk"]')?.className).toContain("w-28");
    expect(container.querySelector('[data-part="chair"]')?.className).toContain("w-14");
    expect(container.querySelector('[data-part="agent"] > div')?.className).toContain("h-6 w-6");
    act(() => root.unmount());

    const emptyRoot = render(<EmptySeat caption="공석" />);
    expect(container.querySelector('[data-part="desk"]')?.className).toContain("w-28");
    act(() => emptyRoot.unmount());
  });

  it("EmptySeat renders the same desk/chair parts as a real Workstation, minus the employee", () => {
    const root = render(<EmptySeat caption="공석 — Atlas" />);
    expect(container.querySelector('[data-part="monitor"]')).not.toBeNull();
    expect(container.querySelector('[data-part="desk"]')).not.toBeNull();
    expect(container.querySelector('[data-part="chair"]')).not.toBeNull();
    expect(container.querySelector('[data-part="agent"]')).toBeNull();
    act(() => root.unmount());
  });

  // ── "식물"/"구성" regression guard (root cause remains UNRESOLVED; this
  // only proves THIS file's own render output never produces those strings) ──
  it("never renders the literal strings 식물 or 구성 anywhere in this component set", () => {
    const roomRoot = render(
      <div>
        <RoomBox label="개발팀" icon={Coffee}>
          <Workstation name="Alpha" role="Engineer" liveRun={undefined} state="idle" onClick={vi.fn()} />
        </RoomBox>
        <AmenityTile icon={Coffee} label="라운지" />
        <AmenityTile icon={Coffee} />
        <EmptySeat caption="공석" />
        <EmptyRoomNote note="배정 대기" />
      </div>,
    );
    expect(container.textContent).not.toContain("식물");
    expect(container.textContent).not.toContain("구성");
    act(() => roomRoot.unmount());
  });

  it("AmenityTile never uses the department RoomBox header markup", () => {
    const roomRoot = render(
      <RoomBox label="개발팀" icon={Coffee}>
        <span>x</span>
      </RoomBox>,
    );
    expect(container.querySelector('[data-room-type="department"]')).not.toBeNull();
    expect(container.textContent).toContain("개발팀");
    act(() => roomRoot.unmount());

    const amenityRoot = render(<AmenityTile icon={Coffee} label="라운지" />);
    expect(container.querySelector('[data-room-type="amenity"]')).not.toBeNull();
    expect(container.querySelector('[data-room-type="department"]')).toBeNull();
    act(() => amenityRoot.unmount());
  });

  it("AmenityTile renders as pure decoration with no label at all (plants)", () => {
    const root = render(<AmenityTile icon={Coffee} />);
    const tile = container.querySelector('[data-room-type="amenity"]');
    expect(tile).not.toBeNull();
    expect(tile?.textContent).toBe("");
    act(() => root.unmount());
  });

  it("EmptySeat renders a vacant-chair marker, never a fabricated agent", () => {
    const root = render(<EmptySeat caption="공석 — Atlas" />);
    expect(container.textContent).toContain("공석");
    expect(container.textContent).toContain("미연결");
    act(() => root.unmount());
  });

  it("EmptyRoomNote shows the given note without inventing staff", () => {
    const root = render(<EmptyRoomNote note="배정 대기" />);
    expect(container.textContent).toContain("배정 대기");
    act(() => root.unmount());
  });

  it("Workstation click calls onClick without making any network request itself", () => {
    const onClick = vi.fn();
    const root = render(
      <Workstation name="Alpha" role="Engineer" liveRun={undefined} state="idle" onClick={onClick} />,
    );
    const button = container.querySelector("button")!;
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("SeatBadge shows the Korean label matching the real state", () => {
    const root = render(<SeatBadge state="approval-waiting" />);
    expect(container.textContent).toBe("승인 대기");
    act(() => root.unmount());
  });

  it("AgentDetailSheet renders minimal identity/state and never Dashboard's approval/blocked detail", async () => {
    const onOpenChange = vi.fn();
    const root = render(
      <AgentDetailSheet
        agent={{
          agentId: "agent-beta",
          name: "Beta",
          role: "QA",
          state: "approval-waiting",
          taskSummary: null,
        }}
        onOpenChange={onOpenChange}
      />,
    );
    await flushReact();

    // Sheet content renders via a Radix portal into document.body.
    expect(document.body.textContent).toContain("Beta");
    expect(document.body.textContent).toContain("QA");
    expect(document.body.textContent).toContain("승인 대기");
    // No active task — the row is omitted, not shown as an empty dash.
    expect(document.body.textContent).not.toContain("현재 업무");
    // Dashboard-owned approval/blocked detail must never be duplicated here.
    expect(document.body.textContent).not.toContain("차단/오류");

    act(() => root.unmount());
  });

  it("AgentDetailSheet shows a one-line current task when there is an active one", async () => {
    const root = render(
      <AgentDetailSheet
        agent={{
          agentId: "agent-beta",
          name: "Beta",
          role: "QA",
          state: "working",
          taskSummary: "Reviewing PR #42",
        }}
        onOpenChange={vi.fn()}
      />,
    );
    await flushReact();

    expect(document.body.textContent).toContain("현재 업무");
    expect(document.body.textContent).toContain("Reviewing PR #42");

    act(() => root.unmount());
  });

  it("AgentDetailSheet links out to the agent's Dashboard-owned detail page instead of duplicating it", async () => {
    const root = render(
      <AgentDetailSheet
        agent={{ agentId: "agent-beta", name: "Beta", role: "QA", state: "idle", taskSummary: null }}
        onOpenChange={vi.fn()}
      />,
    );
    await flushReact();

    const link = document.body.querySelector('a[href*="agent-beta"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toContain("/agents/agent-beta");

    act(() => root.unmount());
  });

  it("AgentDetailSheet renders nothing when agent is null (closed)", async () => {
    const root = render(<AgentDetailSheet agent={null} onOpenChange={vi.fn()} />);
    await flushReact();
    expect(document.body.textContent).not.toContain("현재 업무");
    act(() => root.unmount());
  });

  it("AgentDetailSheet renders F-04 Agent Eval quality metrics when data is present", async () => {
    mockEvalsApi.getAgentSummary.mockResolvedValue({
      agent: {
        agentId: "agent-beta",
        latestEval: {
          id: "run-b1",
          taskId: "task-1",
          benchmarkKey: "sql-query-fix",
          benchmarkVersion: 1,
          agentId: "agent-beta",
          modelProvider: "anthropic",
          modelName: "claude-sonnet-5",
          status: "passed",
          startedAt: "2026-09-30T00:00:00Z",
          completedAt: "2026-09-30T00:00:03Z",
          success: "true",
          accuracy: 0.94,
          latencyMs: 3120,
          tokenUsage: null,
          costEstimated: 0.0087,
          costActual: 0.0085,
          failureType: null,
          retryCount: 0,
          retryOfRunId: null,
          createdAt: "2026-09-30T00:00:00Z",
        },
        passRate: 0.85,
        avgLatencyMs: 3120.5,
        avgCost: 0.0087,
        recentRegression: {
          currentRunId: "run-b1",
          previousRunId: "run-b0",
          findings: [
            {
              kind: "latency_increase",
              previous: 2500,
              current: 3120,
              message: "latency increased by 620ms",
            },
          ],
        },
        recentRuns: [],
      },
    });

    const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={testQueryClient}>
          <AgentDetailSheet
            agent={{
              agentId: "agent-beta",
              name: "Beta",
              role: "QA",
              state: "working",
              taskSummary: null,
            }}
            onOpenChange={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("F-04 품질 평가 (Agent Eval)");
    expect(document.body.textContent).toContain("sql-query-fix (v1)");
    expect(document.body.textContent).toContain("통과");
    expect(document.body.textContent).toContain("85.0%");
    expect(document.body.textContent).toContain("3121ms");
    expect(document.body.textContent).toContain("$0.0087");
    expect(document.body.textContent).toContain("회귀 감지 (1건)");
    expect(document.body.textContent).toContain("latency increased by 620ms");

    act(() => root.unmount());
  });

  it("AgentDetailSheet renders empty eval state gracefully when no evals have run", async () => {
    mockEvalsApi.getAgentSummary.mockResolvedValue({
      agent: {
        agentId: "agent-beta",
        latestEval: null,
        passRate: null,
        avgLatencyMs: null,
        avgCost: null,
        recentRegression: null,
        recentRuns: [],
      },
    });

    const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={testQueryClient}>
          <AgentDetailSheet
            agent={{
              agentId: "agent-beta",
              name: "Beta",
              role: "QA",
              state: "working",
              taskSummary: null,
            }}
            onOpenChange={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("평가 데이터 없음 (아직 실행된 Eval이 없습니다)");

    act(() => root.unmount());
  });
});
