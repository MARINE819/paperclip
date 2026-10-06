// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Coffee } from "lucide-react";

const mockEvalsApi = vi.hoisted(() => ({
  getAgentSummary: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  listWorkProducts: vi.fn(),
}));

vi.mock("../api/evals", () => ({
  evalsApi: mockEvalsApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
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

  // ── M2-06-B01: Agent Execution & Model Observability ──

  it("AgentDetailSheet renders truthful execution and model observability fields when provided", async () => {
    const root = render(
      <AgentDetailSheet
        agent={{
          agentId: "agent-gamma",
          name: "Gamma",
          role: "Architecture Specialist",
          state: "working",
          taskSummary: "Optimizing neural routing graph",
          selectedExecutor: "claude_local",
          actualExecutor: "claude_local",
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          currentToolName: "view_file",
          activeRunId: "run-xyz-789",
          aggregateCostCents: 450,
          currentRunCostCents: 12,
        }}
        onOpenChange={vi.fn()}
      />,
    );
    await flushReact();

    expect(document.body.textContent).toContain("실행 두뇌 및 모델 (Execution & Model)");
    expect(document.body.textContent).toContain("설정된 실행자");
    expect(document.body.textContent).toContain("claude_local");
    expect(document.body.textContent).toContain("실제 실행자");
    expect(document.body.textContent).toContain("제공자 (Provider)");
    expect(document.body.textContent).toContain("anthropic");
    expect(document.body.textContent).toContain("실행 모델 (Model)");
    expect(document.body.textContent).toContain("claude-3-7-sonnet");
    expect(document.body.textContent).toContain("실행 중 도구");
    expect(document.body.textContent).toContain("view_file");
    expect(document.body.textContent).toContain("Run ID");
    expect(document.body.textContent).toContain("run-xyz-789");
    expect(document.body.textContent).toContain("현재 실행 비용");
    expect(document.body.textContent).toContain("$0.12");
    expect(document.body.textContent).toContain("누적 비용 (월간)");
    expect(document.body.textContent).toContain("$4.50");

    act(() => root.unmount());
  });

  it('AgentDetailSheet renders "정보 없음" truthfully without placeholder fabrication when fields are missing', async () => {
    const root = render(
      <AgentDetailSheet
        agent={{
          agentId: "agent-delta",
          name: "Delta",
          role: "Junior Developer",
          state: "idle",
          taskSummary: null,
          selectedExecutor: null,
          actualExecutor: null,
          provider: null,
          model: null,
          aggregateCostCents: null,
          currentRunCostCents: null,
        }}
        onOpenChange={vi.fn()}
      />,
    );
    await flushReact();

    expect(document.body.textContent).toContain("실행 두뇌 및 모델 (Execution & Model)");
    expect(document.body.textContent).toContain("정보 없음");
    expect(document.body.textContent).toContain("정보 없음 (실시간 미집계)");
    // Must NEVER fabricate "Active Execution" or use role as placeholder
    expect(document.body.textContent).not.toContain("Active Execution");

    act(() => root.unmount());
  });

  it("AgentDetailSheet distinguishes selectedExecutor vs actualExecutor when redirection occurs", async () => {
    const root = render(
      <AgentDetailSheet
        agent={{
          agentId: "agent-epsilon",
          name: "Epsilon",
          role: "Fullstack",
          state: "working",
          taskSummary: "Executing complex fallback task",
          selectedExecutor: "claude_local",
          actualExecutor: "codex_local",
          provider: "openai",
          model: "gpt-5.6-sol",
        }}
        onOpenChange={vi.fn()}
      />,
    );
    await flushReact();

    expect(document.body.textContent).toContain("claude_local");
    expect(document.body.textContent).toContain("codex_local");
    expect(document.body.textContent).toContain("openai");
    expect(document.body.textContent).toContain("gpt-5.6-sol");

    act(() => root.unmount());
  });

  // ── M2-06-B03: Work Products / Deliverables Observability ──

  it("AgentDetailSheet renders Work Products list with titles, types, status, and links when data is present", async () => {
    mockIssuesApi.listWorkProducts.mockResolvedValue([
      {
        id: "wp-1",
        companyId: "company-1",
        projectId: "proj-1",
        issueId: "issue-100",
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "pull_request",
        provider: "github",
        externalId: "pr-42",
        title: "PR #42: Feature Alpha Core",
        url: "https://github.com/org/repo/pull/42",
        status: "approved",
        reviewState: "approved",
        isPrimary: true,
        healthStatus: "healthy",
        summary: "Implemented core feature",
        metadata: null,
        sourceTrust: null,
        createdByRunId: "run-1",
        createdAt: new Date("2026-10-01"),
        updatedAt: new Date("2026-10-01"),
      },
      {
        id: "wp-2",
        companyId: "company-1",
        projectId: "proj-1",
        issueId: "issue-100",
        executionWorkspaceId: null,
        runtimeServiceId: null,
        type: "artifact",
        provider: "paperclip",
        externalId: null,
        title: "E2E Walkthrough Video",
        url: "https://storage.paperclip.internal/artifacts/walkthrough.webm",
        status: "ready_for_review",
        reviewState: "needs_board_review",
        isPrimary: false,
        healthStatus: "healthy",
        summary: null,
        metadata: null,
        sourceTrust: null,
        createdByRunId: "run-1",
        createdAt: new Date("2026-10-01"),
        updatedAt: new Date("2026-10-01"),
      },
    ]);

    const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={testQueryClient}>
          <AgentDetailSheet
            agent={{
              agentId: "agent-zeta",
              name: "Zeta",
              role: "Senior Engineer",
              state: "working",
              taskSummary: "Building PR #42",
              currentIssueId: "issue-100",
            }}
            onOpenChange={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("산출물 (Work Products)");
    expect(document.body.textContent).toContain("2건");
    expect(document.body.textContent).toContain("PR #42: Feature Alpha Core");
    expect(document.body.textContent).toContain("승인됨");
    expect(document.body.textContent).toContain("E2E Walkthrough Video");
    expect(document.body.textContent).toContain("검토 대기");

    const links = document.body.querySelectorAll('a[href*="pull/42"], a[href*="walkthrough.webm"]');
    expect(links.length).toBe(2);

    act(() => root.unmount());
  });

  it("AgentDetailSheet renders empty state gracefully when issue has no work products", async () => {
    mockIssuesApi.listWorkProducts.mockResolvedValue([]);

    const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={testQueryClient}>
          <AgentDetailSheet
            agent={{
              agentId: "agent-zeta",
              name: "Zeta",
              role: "Senior Engineer",
              state: "working",
              taskSummary: "Starting new task",
              currentIssueId: "issue-200",
            }}
            onOpenChange={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("산출물 (Work Products)");
    expect(document.body.textContent).toContain("등록된 산출물 없음");

    act(() => root.unmount());
  });

  it("AgentDetailSheet indicates no work products when currentIssueId is null/absent", async () => {
    const root = render(
      <AgentDetailSheet
        agent={{
          agentId: "agent-zeta",
          name: "Zeta",
          role: "Senior Engineer",
          state: "idle",
          taskSummary: null,
          currentIssueId: null,
        }}
        onOpenChange={vi.fn()}
      />,
    );
    await flushReact();

    expect(document.body.textContent).toContain("산출물 (Work Products)");
    expect(document.body.textContent).toContain("등록된 산출물 없음 (진행 중인 이슈 없음)");

    act(() => root.unmount());
  });

  it("AgentDetailSheet renders error state gracefully when work products query fails", async () => {
    mockIssuesApi.listWorkProducts.mockRejectedValue(new Error("API network failure"));

    const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={testQueryClient}>
          <AgentDetailSheet
            agent={{
              agentId: "agent-zeta",
              name: "Zeta",
              role: "Senior Engineer",
              state: "working",
              taskSummary: "Building PR #42",
              currentIssueId: "issue-err",
            }}
            onOpenChange={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("산출물 (Work Products)");
    expect(document.body.textContent).toContain("산출물 데이터 조회 실패");

    act(() => root.unmount());
  });

  // ── Status Consistency & 6-Tier Priority Hierarchy ──

  it("computeSeatState correctly computes 'in-review' and enforces the 6-tier hierarchy", () => {
    const now = Date.now();
    const healthyAgent = { status: "idle" as const, lastHeartbeatAt: new Date(now) };
    const offlineAgent = { status: "idle" as const, lastHeartbeatAt: null };
    const errorAgent = { status: "error" as const, lastHeartbeatAt: null };

    // 1. in-review returns "in-review" when agent has an issue in review
    expect(computeSeatState(healthyAgent, false, false, now, true)).toBe("in-review");
    expect(computeSeatState(offlineAgent, false, false, now, true)).toBe("in-review");

    // 2. Priority: blocked-error > approval-waiting > working > in-review > offline > idle
    // blocked-error beats all
    expect(computeSeatState(errorAgent, true, true, now, true)).toBe("blocked-error");
    // approval-waiting beats working and in-review
    expect(computeSeatState(healthyAgent, true, true, now, true)).toBe("approval-waiting");
    // working beats in-review
    expect(computeSeatState(healthyAgent, true, false, now, true)).toBe("working");
    // in-review beats offline
    expect(computeSeatState(offlineAgent, false, false, now, true)).toBe("in-review");
    // offline when no in-review
    expect(computeSeatState(offlineAgent, false, false, now, false)).toBe("offline");
    // idle when healthy with no active states
    expect(computeSeatState(healthyAgent, false, false, now, false)).toBe("idle");
  });

  it("SeatBadge renders '검토 대기' with --status-task-in_review for in-review state", () => {
    const root = render(<SeatBadge state="in-review" />);
    expect(container.textContent).toBe("검토 대기");
    const chip = container.querySelector(".status-chip") as HTMLElement;
    expect(chip.style.getPropertyValue("--sc")).toBe("var(--status-task-in_review)");
    act(() => root.unmount());
  });

  it("MiniAgentFigure renders with --status-task-in_review background in in-review state", () => {
    const root = render(<MiniAgentFigure state="in-review" />);
    const figure = container.querySelector('[data-seat-state="in-review"]');
    expect(figure).not.toBeNull();
    const head = figure?.querySelector(".rounded-full") as HTMLElement;
    expect(head.style.backgroundColor).toBe("var(--status-task-in_review)");
    act(() => root.unmount());
  });
});


