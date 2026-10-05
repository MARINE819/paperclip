// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Approval, Issue } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import {
  AgentOperationsPanel,
  buildAgentOpsRows,
  currentIssueFor,
  deriveAgentOpsCategory,
  taskSummaryFor,
} from "./AgentOperationsPanel";

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockHeartbeatsApi = vi.hoisted(() => ({ liveRunsForCompany: vi.fn() }));
const mockApprovalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn(), listWorkProducts: vi.fn() }));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));
vi.mock("@/api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    orgUnitId: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

function makeLiveRun(overrides: Partial<LiveRunForIssue> = {}): LiveRunForIssue {
  return {
    id: "run-1",
    status: "running",
    invocationSource: "manual",
    triggerDetail: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    agentId: "agent-1",
    agentName: "Alpha",
    adapterType: "codex_local",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "ENG-1",
    title: "Fix the thing",
    status: "in_progress",
    assigneeAgentId: "agent-1",
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Issue;
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Approval;
}

describe("deriveAgentOpsCategory (pure)", () => {
  const now = Date.now();

  it("classifies error status as blocked-error regardless of other signals", () => {
    expect(deriveAgentOpsCategory({ status: "error", lastHeartbeatAt: null }, true, true, now)).toBe(
      "blocked-error",
    );
  });

  it("classifies a pending approval as approval-waiting even while idle", () => {
    expect(deriveAgentOpsCategory({ status: "idle", lastHeartbeatAt: new Date(now) }, false, true, now)).toBe(
      "approval-waiting",
    );
  });

  it("classifies a real live run as working", () => {
    expect(deriveAgentOpsCategory({ status: "running", lastHeartbeatAt: new Date(now) }, true, false, now)).toBe(
      "working",
    );
  });

  it("classifies no heartbeat as offline, never fabricating idle", () => {
    expect(deriveAgentOpsCategory({ status: "idle", lastHeartbeatAt: null }, false, false, now)).toBe("offline");
  });

  it("classifies a recent heartbeat with nothing else going on as idle", () => {
    expect(deriveAgentOpsCategory({ status: "idle", lastHeartbeatAt: new Date(now) }, false, false, now)).toBe(
      "idle",
    );
  });
});

describe("taskSummaryFor (pure)", () => {
  it("returns an explicit Korean 'none' string, never a bare dash, when there is no live run", () => {
    expect(taskSummaryFor(undefined)).toBe("현재 작업 없음");
  });

  it("prefers the real status message over other fields", () => {
    expect(taskSummaryFor(makeLiveRun({ currentStatusMessage: "Doing the thing" }))).toBe("Doing the thing");
  });
});

describe("currentIssueFor (pure)", () => {
  it("only matches the agent's own open issues, never a done/cancelled one", () => {
    const issues = [
      makeIssue({ id: "i1", assigneeAgentId: "agent-1", status: "done", updatedAt: new Date("2026-02-01") }),
      makeIssue({ id: "i2", assigneeAgentId: "agent-1", status: "in_progress", updatedAt: new Date("2026-01-05") }),
      makeIssue({ id: "i3", assigneeAgentId: "agent-2", status: "todo", updatedAt: new Date("2026-02-10") }),
    ];
    const result = currentIssueFor("agent-1", issues);
    expect(result?.id).toBe("i2");
  });

  it("returns undefined rather than a fabricated issue when none match", () => {
    expect(currentIssueFor("agent-1", [])).toBeUndefined();
  });
});

describe("buildAgentOpsRows (pure)", () => {
  it("wires each agent to its own live run, issue and approval — never another agent's", () => {
    const now = Date.now();
    const agents = [makeAgent({ id: "a1", name: "Alpha" }), makeAgent({ id: "a2", name: "Beta", status: "error" })];
    const liveRuns = [makeLiveRun({ agentId: "a1" })];
    const issues = [makeIssue({ id: "i1", assigneeAgentId: "a1" })];
    const rows = buildAgentOpsRows(agents, liveRuns, new Set(["a2"]), issues, now);

    expect(rows.find((r) => r.agent.id === "a1")?.category).toBe("working");
    expect(rows.find((r) => r.agent.id === "a1")?.currentIssue?.id).toBe("i1");
    // a2 has a pending approval AND status error — error takes precedence.
    expect(rows.find((r) => r.agent.id === "a2")?.category).toBe("blocked-error");
    expect(rows.find((r) => r.agent.id === "a2")?.currentIssue).toBeUndefined();
  });
});

describe("AgentOperationsPanel", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockAgentsApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockApprovalsApi.list.mockResolvedValue([]);
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentOperationsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("shows the six real operational counts, not a fabricated single score", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "a1", name: "Alpha", status: "running" }),
      makeAgent({ id: "a2", name: "Beta", status: "error" }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([makeLiveRun({ agentId: "a1" })]);
    const root = await render();

    expect(container.textContent).toContain("전체");
    expect(container.textContent).toContain("업무 중");
    expect(container.textContent).toContain("오류/차단");
    expect(container.textContent).toContain("오프라인");

    act(() => root.unmount());
  });

  it("renders a roster row per real agent with name/role/state/task/issue/heartbeat", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "a1", name: "Alpha", title: "Senior Engineer", status: "running" }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ agentId: "a1", currentStatusMessage: "Refactoring the payments module" }),
    ]);
    mockIssuesApi.list.mockResolvedValue([makeIssue({ assigneeAgentId: "a1" })]);
    const root = await render();

    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Senior Engineer");
    expect(container.textContent).toContain("Refactoring the payments module");
    expect(container.textContent).toContain("ENG-1");
    expect(container.textContent).toContain("하트비트 기록 없음");

    act(() => root.unmount());
  });

  it("shows explicit 'none' text instead of a bare dash when an agent has no task or issue", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "a1", name: "Alpha" })]);
    const root = await render();

    expect(container.textContent).toContain("현재 작업 없음");
    expect(container.textContent).toContain("배정된 이슈 없음");

    act(() => root.unmount());
  });

  it("opens a detail sheet with full operational data on row click, including approval/blocked/heartbeat/work-product", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "a1", name: "Alpha", lastHeartbeatAt: new Date() })]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ agentId: "a1", currentStatusMessage: "Building the report" }),
    ]);
    mockIssuesApi.list.mockResolvedValue([makeIssue({ id: "i1", assigneeAgentId: "a1" })]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([{ id: "wp1" }]);
    mockApprovalsApi.list.mockResolvedValue([makeApproval({ requestedByAgentId: "a1" })]);
    const root = await render();

    const row = container.querySelector('[data-testid="agent-ops-row"]')!;
    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    await flushReact();

    // Sheet renders via a Radix portal into document.body.
    expect(document.body.textContent).toContain("Alpha");
    expect(document.body.textContent).toContain("Building the report");
    expect(document.body.textContent).toContain("현재 Issue");
    expect(document.body.textContent).toContain("승인 대기");
    expect(document.body.textContent).toContain("차단/오류");
    expect(document.body.textContent).toContain("Work Product");
    expect(document.body.textContent).toContain("1개 있음");

    act(() => root.unmount());
  });
});
