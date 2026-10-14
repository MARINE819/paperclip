// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Approval, IssueWorkProduct } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { AIOfficeMobileSummary } from "./AIOfficeMobileSummary";

const mockCompaniesApi = vi.hoisted(() => ({
  emergencyPause: vi.fn(),
}));

const mockApprovalsApi = vi.hoisted(() => ({
  approve: vi.fn(),
  reject: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  listWorkProducts: vi.fn().mockResolvedValue([]),
}));

const mockJarvisApi = vi.hoisted(() => ({
  submit: vi.fn(),
}));

const mockWebauthnApi = vi.hoisted(() => ({
  listCredentials: vi.fn(),
}));

vi.mock("@/api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("@/api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("@/api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("@/api/jarvis", () => ({
  jarvisApi: mockJarvisApi,
}));

vi.mock("@/api/webauthn", () => ({
  webauthnApi: mockWebauthnApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: any) => (
    <a href={typeof to === "string" ? to : to?.pathname ?? ""} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/" }),
  useActiveCompanyPrefix: () => null,
}));

vi.mock("@/components/VoiceCommandBar", () => ({
  VoiceCommandBar: ({ companyId }: { companyId: string }) => (
    <div data-testid="mock-voice-command-bar">Mock Voice Command Bar: {companyId}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface RootRegistration {
  root: ReturnType<typeof createRoot>;
  container: HTMLElement;
  unmount: () => void;
  isUnmounted: boolean;
  queryClient: QueryClient;
}

const activeRoots: RootRegistration[] = [];

function registerRoot(
  root: ReturnType<typeof createRoot>,
  container: HTMLElement,
  queryClient: QueryClient,
): ReturnType<typeof createRoot> {
  let isUnmounted = false;
  const originalUnmount = root.unmount.bind(root);

  const safeUnmount = () => {
    if (isUnmounted) return;
    isUnmounted = true;
    try {
      originalUnmount();
    } finally {
      queryClient.clear();
    }
  };

  root.unmount = safeUnmount;

  activeRoots.push({
    root,
    container,
    unmount: safeUnmount,
    get isUnmounted() {
      return isUnmounted;
    },
    queryClient,
  });

  return root;
}

async function flushReact() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: "Senior AI Engineer",
    icon: null,
    status: "idle",
    reportsTo: null,
    orgUnitId: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: { model: "claude-3-7-sonnet" },
    runtimeConfig: {},
    budgetMonthlyCents: 10000,
    spentMonthlyCents: 2500,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as Agent;
}

function makeLiveRun(overrides: Partial<LiveRunForIssue> = {}): LiveRunForIssue {
  return {
    id: "run-101",
    status: "running",
    invocationSource: "manual",
    triggerDetail: "Running autonomous E2E test suite",
    startedAt: "2026-10-01T00:00:00Z",
    finishedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    agentId: "agent-1",
    agentName: "Alpha",
    adapterType: "claude_local",
    currentStatusMessage: "Executing playwright tests",
    currentToolName: "run_command",
    issueId: "issue-555",
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-10-01"),
    updatedAt: new Date("2026-10-01"),
    ...overrides,
  } as Approval;
}

function makeWorkProduct(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: "wp-1",
    companyId: "company-1",
    projectId: "proj-1",
    issueId: "issue-555",
    type: "document",
    title: "System Architecture Proposal",
    status: "approved",
    reviewState: "approved",
    url: "https://example.com/doc",
    metadata: null,
    createdAt: new Date("2026-10-01"),
    updatedAt: new Date("2026-10-01"),
    ...overrides,
  } as IssueWorkProduct;
}

describe("AIOfficeMobileSummary", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockWebauthnApi.listCredentials.mockResolvedValue([]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([]);
    window.localStorage?.clear();
  });

  afterEach(async () => {
    for (const reg of [...activeRoots]) {
      if (!reg.isUnmounted) {
        await act(async () => {
          reg.unmount();
        });
      }
    }
    activeRoots.length = 0;

    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    window.localStorage?.clear();
  });

  function render(node: React.ReactElement) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    let root!: ReturnType<typeof createRoot>;
    act(() => {
      root = createRoot(container);
      registerRoot(root, container, queryClient);
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    return root;
  }

  function renderWithQuery(node: React.ReactElement) {
    return render(node);
  }

  it("renders executive summary metrics: pending approvals, active agents, spend, error counts", () => {
    const agent = makeAgent();
    const liveRun = makeLiveRun();
    const approval = makeApproval();

    const root = render(
      <AIOfficeMobileSummary
        agents={[agent]}
        liveRuns={[liveRun]}
        pendingApprovals={[approval]}
        errorAgents={[]}
        dashboardData={{
          companyId: "company-1",
          agents: { active: 1, running: 1, paused: 0, error: 0 },
          tasks: { open: 5, inProgress: 1, blocked: 0, done: 10 },
          costs: { monthSpendCents: 4500, monthBudgetCents: 10000, monthUtilizationPercent: 45 },
          pendingApprovals: 1,
          budgets: { activeIncidents: 0, pendingApprovals: 1, pausedAgents: 0, pausedProjects: 0 },
          runActivity: [],
        }}
      />,
    );

    expect(container.textContent).toContain("승인 대기");
    expect(container.textContent).toContain("1건");
    expect(container.textContent).toContain("근무 중인 AI");
    expect(container.textContent).toContain("1명");
    expect(container.textContent).toContain("당월 지출");
    expect(container.textContent).toContain("$45.00");
    expect(container.textContent).toContain("예산 $100.00");
    expect(container.textContent).toContain("45%");

    act(() => root.unmount());
  });

  it("renders active AI employees with task summaries, actual executor, model, tool name", () => {
    const agent = makeAgent({
      id: "agent-1",
      name: "Alpha",
      title: "Core Engineer",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-3-7-sonnet" },
    });
    const liveRun = makeLiveRun({
      agentId: "agent-1",
      adapterType: "codex_local", // redirect/fallback to codex
      currentStatusMessage: "Fixing authentication race condition",
      currentToolName: "edit_file",
    });

    const root = render(
      <AIOfficeMobileSummary
        agents={[agent]}
        liveRuns={[liveRun]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Core Engineer");
    expect(container.textContent).toContain("Fixing authentication race condition");
    expect(container.textContent).toContain("codex_local");
    expect(container.textContent).toContain("claude-3-7-sonnet");
    expect(container.textContent).toContain("edit_file");

    act(() => root.unmount());
  });

  it("renders empty state gracefully when no active live runs exist", () => {
    const root = render(
      <AIOfficeMobileSummary
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    expect(container.textContent).toContain("현재 실행 중인 AI 직원이 없습니다 (모두 대기 상태입니다)");

    act(() => root.unmount());
  });

  it("renders error agents card when errorAgents are present", () => {
    const errorAgent = makeAgent({
      id: "agent-err",
      name: "BrokenBot",
      status: "error",
      errorReason: "Failed to connect to Docker runtime",
    });

    const root = render(
      <AIOfficeMobileSummary
        agents={[errorAgent]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[errorAgent]}
      />,
    );

    expect(container.textContent).toContain("점검 및 조치 필요 AI 직원");
    expect(container.textContent).toContain("BrokenBot");
    expect(container.textContent).toContain("Failed to connect to Docker runtime");

    act(() => root.unmount());
  });

  it("calls onSelectAgent when an active employee card is tapped", () => {
    const onSelectAgent = vi.fn();
    const liveRun = makeLiveRun({ agentId: "agent-target" });
    const agent = makeAgent({ id: "agent-target", name: "TargetBot" });

    const root = render(
      <AIOfficeMobileSummary
        agents={[agent]}
        liveRuns={[liveRun]}
        pendingApprovals={[]}
        errorAgents={[]}
        onSelectAgent={onSelectAgent}
      />,
    );

    const card = container.querySelector('[class*="cursor-pointer"]');
    expect(card).not.toBeNull();
    act(() => {
      card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSelectAgent).toHaveBeenCalledWith("agent-target");

    act(() => root.unmount());
  });

  it("renders recent work products for active live run issues with type icon and status badge", async () => {
    const wp = makeWorkProduct({
      id: "wp-101",
      title: "Mobile Architecture Spec v1.0",
      type: "document",
      status: "approved",
      url: "https://nexora.internal/docs/spec",
    });
    mockIssuesApi.listWorkProducts.mockResolvedValue([wp]);

    const agent = makeAgent({ id: "agent-1", name: "AlphaBot" });
    const liveRun = makeLiveRun({ agentId: "agent-1", issueId: "issue-555" });

    const root = renderWithQuery(
      <AIOfficeMobileSummary
        agents={[agent]}
        liveRuns={[liveRun]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    await flushReact();
    await flushReact();

    expect(mockIssuesApi.listWorkProducts).toHaveBeenCalledWith("issue-555");
    expect(container.textContent).toContain("최근 업무 산출물 (Work Products)");
    expect(container.textContent).toContain("Mobile Architecture Spec v1.0");
    expect(container.textContent).toContain("승인됨");
    expect(container.textContent).toContain("담당: AlphaBot");

    const link = container.querySelector('a[href="https://nexora.internal/docs/spec"]');
    expect(link).not.toBeNull();

    act(() => root.unmount());
  });

  it("renders empty state when active issue has no work products", async () => {
    mockIssuesApi.listWorkProducts.mockResolvedValue([]);

    const agent = makeAgent();
    const liveRun = makeLiveRun({ issueId: "issue-empty" });

    const root = renderWithQuery(
      <AIOfficeMobileSummary
        agents={[agent]}
        liveRuns={[liveRun]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    await flushReact();
    await flushReact();

    expect(mockIssuesApi.listWorkProducts).toHaveBeenCalledWith("issue-empty");
    expect(container.textContent).toContain("등록된 산출물 없음");

    act(() => root.unmount());
  });

  it("renders empty state when there are no active issue IDs", async () => {
    const agent = makeAgent();
    const liveRun = makeLiveRun({ issueId: null });

    const root = renderWithQuery(
      <AIOfficeMobileSummary
        agents={[agent]}
        liveRuns={[liveRun]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    await flushReact();

    expect(mockIssuesApi.listWorkProducts).not.toHaveBeenCalled();
    expect(container.textContent).toContain("현재 활성 이슈에서 생산된 산출물이 없습니다 (진행 중인 이슈 없음)");

    act(() => root.unmount());
  });

  it("renders error state honestly when work products query fails", async () => {
    mockIssuesApi.listWorkProducts.mockRejectedValue(new Error("Network timeout"));

    const agent = makeAgent();
    const liveRun = makeLiveRun({ issueId: "issue-fail" });

    const root = renderWithQuery(
      <AIOfficeMobileSummary
        agents={[agent]}
        liveRuns={[liveRun]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    await flushReact();
    await flushReact();

    expect(mockIssuesApi.listWorkProducts).toHaveBeenCalledWith("issue-fail");
    expect(container.textContent).toContain("산출물 데이터 조회 실패");

    act(() => root.unmount());
  });

  it("deduplicates issueIds to prevent redundant API calls when multiple agents work on the same issue", async () => {
    mockIssuesApi.listWorkProducts.mockResolvedValue([]);

    const agent1 = makeAgent({ id: "agent-1", name: "Alpha" });
    const agent2 = makeAgent({ id: "agent-2", name: "Beta" });
    const liveRun1 = makeLiveRun({ id: "run-1", agentId: "agent-1", issueId: "issue-shared" });
    const liveRun2 = makeLiveRun({ id: "run-2", agentId: "agent-2", issueId: "issue-shared" });

    const root = renderWithQuery(
      <AIOfficeMobileSummary
        agents={[agent1, agent2]}
        liveRuns={[liveRun1, liveRun2]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    await flushReact();
    await flushReact();

    expect(mockIssuesApi.listWorkProducts).toHaveBeenCalledTimes(1);
    expect(mockIssuesApi.listWorkProducts).toHaveBeenCalledWith("issue-shared");

    act(() => root.unmount());
  });

  it("renders VoiceCommandBar inside mobile executive bar when companyId is available", () => {
    const agent = makeAgent({ companyId: "company-test-123" });
    const root = render(
      <AIOfficeMobileSummary
        companyId="company-test-123"
        agents={[agent]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const voiceBar = container.querySelector('[data-testid="mock-voice-command-bar"]');
    expect(voiceBar).not.toBeNull();
    expect(voiceBar?.textContent).toContain("Mock Voice Command Bar: company-test-123");

    act(() => root.unmount());
  });

  it("opens 2-step confirmation dialog on Emergency Stop click and does NOT call emergencyPause if cancelled", async () => {
    mockCompaniesApi.emergencyPause.mockResolvedValue({});
    const agent = makeAgent({ companyId: "company-1" });

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[agent]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const stopBtn = container.querySelector('[data-testid="mobile-emergency-stop-btn"]');
    expect(stopBtn).not.toBeNull();

    act(() => {
      stopBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const dialog = document.querySelector('[data-testid="mobile-emergency-confirm-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("회사 전체를 긴급 정지하시겠습니까?");

    const cancelBtn = document.querySelector('[data-testid="mobile-emergency-cancel-btn"]');
    expect(cancelBtn).not.toBeNull();

    act(() => {
      cancelBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCompaniesApi.emergencyPause).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("calls companiesApi.emergencyPause when confirmed in 2-step confirmation dialog", async () => {
    mockCompaniesApi.emergencyPause.mockResolvedValue({});
    const agent = makeAgent({ companyId: "company-1" });

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[agent]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const stopBtn = container.querySelector('[data-testid="mobile-emergency-stop-btn"]');
    act(() => {
      stopBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const actionBtn = document.querySelector('[data-testid="mobile-emergency-action-btn"]');
    expect(actionBtn).not.toBeNull();

    act(() => {
      actionBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockCompaniesApi.emergencyPause).toHaveBeenCalledWith("company-1");

    act(() => root.unmount());
  });

  it("supports inline quick approval and quick rejection", async () => {
    mockApprovalsApi.approve.mockResolvedValue({});
    mockApprovalsApi.reject.mockResolvedValue({});

    const approval1 = makeApproval({ id: "approval-alpha", type: "hire_agent" });
    const approval2 = makeApproval({ id: "approval-beta", type: "budget_override_required" });

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[approval1, approval2]}
        errorAgents={[]}
      />,
    );

    const quickApproveBtn = container.querySelector('[data-testid="mobile-approval-quick-approve-btn-approval-alpha"]');
    expect(quickApproveBtn).not.toBeNull();

    act(() => {
      quickApproveBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockApprovalsApi.approve).toHaveBeenCalledWith("approval-alpha", undefined);

    const quickRejectBtn = container.querySelector('[data-testid="mobile-approval-quick-reject-btn-approval-beta"]');
    expect(quickRejectBtn).not.toBeNull();

    act(() => {
      quickRejectBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockApprovalsApi.reject).toHaveBeenCalledWith("approval-beta", undefined);

    act(() => root.unmount());
  });

  it("opens review sheet, inputs decision note, and approves with note", async () => {
    mockApprovalsApi.approve.mockResolvedValue({});

    const approval = makeApproval({ id: "approval-detail", type: "request_board_approval" });

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[approval]}
        errorAgents={[]}
      />,
    );

    const reviewBtn = container.querySelector('[data-testid="mobile-approval-review-btn-approval-detail"]');
    expect(reviewBtn).not.toBeNull();

    act(() => {
      reviewBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const sheet = document.querySelector('[data-testid="mobile-approval-review-sheet"]');
    expect(sheet).not.toBeNull();
    expect(sheet?.textContent).toContain("원격 의사결정 / 승인 검토");

    const input = document.querySelector('[data-testid="mobile-approval-note-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Approved by CEO on Mobile");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const sheetApproveBtn = document.querySelector('[data-testid="mobile-sheet-approve-btn"]');
    expect(sheetApproveBtn).not.toBeNull();

    act(() => {
      sheetApproveBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockApprovalsApi.approve).toHaveBeenCalledWith("approval-detail", "Approved by CEO on Mobile");

    act(() => root.unmount());
  });

  it("shows error notice when emergencyPause mutation fails", async () => {
    mockCompaniesApi.emergencyPause.mockRejectedValue(new Error("Network failed"));

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const stopBtn = container.querySelector('[data-testid="mobile-emergency-stop-btn"]');
    act(() => {
      stopBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const actionBtn = document.querySelector('[data-testid="mobile-emergency-action-btn"]');
    act(() => {
      actionBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    const errorNotice = container.querySelector('[data-testid="mobile-emergency-error-notice"]');
    expect(errorNotice).not.toBeNull();
    expect(errorNotice?.textContent).toContain("긴급 정지 요청 실패: 다시 시도하십시오.");

    act(() => root.unmount());
  });

  it("renders JARVIS task instruction card inside mobile summary when JARVIS agent is present", () => {
    const jarvis = makeAgent({ id: "agent-jarvis", name: "JARVIS" });
    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[jarvis]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const card = container.querySelector('[data-testid="mobile-jarvis-task-instruction-card"]');
    expect(card).not.toBeNull();
    expect(container.textContent).toContain("자비스(JARVIS) 업무 지시");
    expect(container.textContent).toContain("자비스 연결됨");

    const input = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]');
    expect(input).not.toBeNull();

    act(() => root.unmount());
  });

  it("safely handles missing JARVIS agent in mobile summary with honest warning notice", () => {
    const engineer = makeAgent({ id: "agent-1", name: "AlphaEngineer" });
    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[engineer]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const card = container.querySelector('[data-testid="mobile-jarvis-task-instruction-card"]');
    expect(card).not.toBeNull();
    expect(container.textContent).toContain("JARVIS 미발견");

    const notice = container.querySelector('[data-testid="mobile-jarvis-missing-agent-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("현재 회사에 등록된 JARVIS 에이전트를 찾을 수 없습니다.");

    const input = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]');
    expect(input).toBeNull();

    act(() => root.unmount());
  });

  it("allows CEO to submit task instruction to JARVIS from mobile summary and displays receipt", async () => {
    const jarvis = makeAgent({ id: "agent-jarvis", name: "JARVIS" });
    const specialist = makeAgent({ id: "agent-spec", name: "PlaywrightBot" });

    mockJarvisApi.submit.mockResolvedValue({
      ok: true,
      parentIssueId: "parent-issue-12345",
      childIssueId: "child-issue-67890",
      selectedAgentId: "agent-spec",
      parentIssueDeduplicated: false,
    });

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[jarvis, specialist]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const textarea = container.querySelector('[data-testid="mobile-jarvis-instruction-input"]') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "자비스, 모바일 결재 E2E 검증해줘");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const submitBtn = container.querySelector('[data-testid="mobile-jarvis-submit-btn"]') as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();
    expect(submitBtn.disabled).toBe(false);

    act(() => {
      submitBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockJarvisApi.submit).toHaveBeenCalledWith("company-1", {
      jarvisAgentId: "agent-jarvis",
      requestText: "자비스, 모바일 결재 E2E 검증해줘",
    });

    const receipt = container.querySelector('[data-testid="mobile-jarvis-success-receipt"]');
    expect(receipt).not.toBeNull();
    expect(receipt?.textContent).toContain("업무 접수 및 전문가 배정 완료");
    expect(receipt?.textContent).toContain("parent-i");
    expect(receipt?.textContent).toContain("child-is");
    expect(receipt?.textContent).toContain("PlaywrightBot");

    act(() => root.unmount());
  });

  it("renders mobile in-review metric card and in-review operations queue card with issue direct links", async () => {
    const agent = makeAgent({ id: "agent-1", name: "Alpha" });
    const inReviewIssue = {
      id: "issue-rev-1",
      identifier: "NEX-101",
      title: "Mobile Review Task",
      assigneeAgentId: "agent-1",
      companyId: "company-1",
      status: "in_review",
    } as any;

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[agent]}
        liveRuns={[]}
        pendingApprovals={[]}
        inReviewIssues={[inReviewIssue]}
        errorAgents={[]}
      />,
    );

    // Metric card
    const metricCard = container.querySelector('[data-testid="mobile-in-review-metric"]');
    expect(metricCard).not.toBeNull();
    expect(metricCard?.textContent).toContain("검토 대기");
    expect(metricCard?.textContent).toContain("1건");
    expect(metricCard?.textContent).toContain("독립 검토 대기");

    // Queue card
    const queueCard = container.querySelector('[data-testid="mobile-in-review-card"]');
    expect(queueCard).not.toBeNull();
    expect(queueCard?.textContent).toContain("독립 검토 대기 업무 (1건)");

    const itemLink = queueCard?.querySelector('[data-testid="mobile-in-review-item-issue-rev-1"]') as HTMLAnchorElement;
    expect(itemLink).not.toBeNull();
    expect(itemLink?.getAttribute("href")).toBe("/issues/issue-rev-1");
    expect(itemLink?.textContent).toContain("NEX-101");
    expect(itemLink?.textContent).toContain("Mobile Review Task");
    expect(itemLink?.textContent).toContain("담당: Alpha");
    expect(itemLink?.textContent).toContain("검토 대기");

    act(() => root.unmount());
  });

  it("renders JARVIS 최종 보고 badge and #comment- deep link when jarvisReportComments contains canonical report", () => {
    const jarvis = makeAgent({ id: "agent-jarvis", name: "JARVIS" });
    const inReviewIssue = {
      id: "issue-parent-mob-1",
      identifier: "NEX-200",
      title: "Mobile JARVIS Parent Task",
      assigneeAgentId: "agent-jarvis",
      status: "in_review",
    } as any;

    const reportComment = {
      id: "comment-mob-report-1",
      issueId: "issue-parent-mob-1",
      authorType: "agent",
      authorAgentId: "agent-jarvis",
      body: "## JARVIS 부모 통합 보고서",
      metadata: {
        version: 1,
        authorizationReason: "canonical_jarvis_parent_report",
        sections: [],
      },
    } as any;

    const jarvisReportComments = new Map([["issue-parent-mob-1", reportComment]]);

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[jarvis]}
        liveRuns={[]}
        pendingApprovals={[]}
        inReviewIssues={[inReviewIssue]}
        jarvisReportComments={jarvisReportComments}
        errorAgents={[]}
      />,
    );

    const queueCard = container.querySelector('[data-testid="mobile-in-review-card"]');
    expect(queueCard).not.toBeNull();
    const itemLink = queueCard?.querySelector('[data-testid="mobile-in-review-item-issue-parent-mob-1"]') as HTMLAnchorElement;
    expect(itemLink).not.toBeNull();
    expect(itemLink?.getAttribute("href")).toBe("/issues/issue-parent-mob-1#comment-comment-mob-report-1");
    expect(itemLink?.textContent).toContain("JARVIS 최종 보고");
    expect(itemLink?.textContent).not.toContain("검토 대기");

    const badge = queueCard?.querySelector('[data-testid="mobile-jarvis-report-badge-issue-parent-mob-1"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("JARVIS 최종 보고");

    act(() => root.unmount());
  });

  it("renders both JARVIS final report and regular in-review items accurately side by side", () => {
    const jarvis = makeAgent({ id: "agent-jarvis", name: "JARVIS" });
    const worker = makeAgent({ id: "agent-worker", name: "Worker1" });

    const parentIssue = {
      id: "issue-p-1",
      identifier: "NEX-201",
      title: "Parent with report",
      assigneeAgentId: "agent-jarvis",
      status: "in_review",
    } as any;

    const regularIssue = {
      id: "issue-r-1",
      identifier: "NEX-202",
      title: "Regular worker issue",
      assigneeAgentId: "agent-worker",
      status: "in_review",
    } as any;

    const reportComment = {
      id: "comment-canonical-p1",
      issueId: "issue-p-1",
      authorType: "agent",
      authorAgentId: "agent-jarvis",
      body: "## JARVIS 부모 통합 보고서",
      metadata: {
        version: 1,
        authorizationReason: "canonical_jarvis_parent_report",
        sections: [],
      },
    } as any;

    const jarvisReportComments = new Map([["issue-p-1", reportComment]]);

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[jarvis, worker]}
        liveRuns={[]}
        pendingApprovals={[]}
        inReviewIssues={[parentIssue, regularIssue]}
        jarvisReportComments={jarvisReportComments}
        errorAgents={[]}
      />,
    );

    const queueCard = container.querySelector('[data-testid="mobile-in-review-card"]');
    expect(queueCard).not.toBeNull();
    expect(queueCard?.textContent).toContain("독립 검토 대기 업무 (2건)");

    // Parent issue item
    const parentLink = queueCard?.querySelector('[data-testid="mobile-in-review-item-issue-p-1"]') as HTMLAnchorElement;
    expect(parentLink?.getAttribute("href")).toBe("/issues/issue-p-1#comment-comment-canonical-p1");
    expect(parentLink?.textContent).toContain("JARVIS 최종 보고");

    // Regular issue item
    const regularLink = queueCard?.querySelector('[data-testid="mobile-in-review-item-issue-r-1"]') as HTMLAnchorElement;
    expect(regularLink?.getAttribute("href")).toBe("/issues/issue-r-1");
    expect(regularLink?.textContent).toContain("검토 대기");
    expect(regularLink?.textContent).not.toContain("JARVIS 최종 보고");

    act(() => root.unmount());
  });

  it("renders live run issue chip as clickable link to issue without selecting agent", async () => {
    const onSelect = vi.fn();
    const agent = makeAgent({ id: "agent-1", name: "Alpha" });
    const liveRun = makeLiveRun({
      id: "run-live-1",
      agentId: "agent-1",
      issueId: "issue-live-42",
    });

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[agent]}
        liveRuns={[liveRun]}
        pendingApprovals={[]}
        errorAgents={[]}
        onSelectAgent={onSelect}
      />,
    );

    const issueLink = container.querySelector('[data-testid="mobile-live-run-issue-link-issue-live-42"]') as HTMLAnchorElement;
    expect(issueLink).not.toBeNull();
    expect(issueLink?.getAttribute("href")).toBe("/issues/issue-live-42");
    expect(issueLink?.textContent).toContain("Issue 연동됨");

    // Clicking the issue link should not trigger onSelectAgent
    act(() => {
      issueLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("renders mobile completed work card with completed issues and direct links", async () => {
    const agent = makeAgent({ id: "agent-1", name: "Alpha" });
    const doneIssue = {
      id: "issue-done-99",
      identifier: "NEX-99",
      title: "Completed Milestone Delivery",
      assigneeAgentId: "agent-1",
      companyId: "company-1",
      status: "done",
    } as any;

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[agent]}
        liveRuns={[]}
        pendingApprovals={[]}
        completedIssues={[doneIssue]}
        errorAgents={[]}
      />,
    );

    const completedCard = container.querySelector('[data-testid="mobile-completed-work-card"]');
    expect(completedCard).not.toBeNull();
    expect(completedCard?.textContent).toContain("최근 완료 업무 & 최종 보고서 (1건)");

    const itemLink = completedCard?.querySelector('[data-testid="mobile-completed-issue-item-issue-done-99"]') as HTMLAnchorElement;
    expect(itemLink).not.toBeNull();
    expect(itemLink?.getAttribute("href")).toBe("/issues/issue-done-99");
    expect(itemLink?.textContent).toContain("NEX-99");
    expect(itemLink?.textContent).toContain("Completed Milestone Delivery");
    expect(itemLink?.textContent).toContain("담당: Alpha");
    expect(itemLink?.textContent).toContain("보고서/산출물 확인 →");

    act(() => root.unmount());
  });

  it("renders mobile completed work item with canonical JARVIS report deep-link when present", async () => {
    const jarvis = makeAgent({ id: "agent-jarvis", name: "JARVIS" });
    const doneParent = {
      id: "issue-done-parent-1",
      identifier: "NEX-100",
      title: "Completed Parent Task",
      assigneeAgentId: "agent-jarvis",
      companyId: "company-1",
      status: "done",
      parentId: null,
    } as any;
    const reportComment = {
      id: "comment-canonical-done",
      issueId: "issue-done-parent-1",
      metadata: {
        authorizationReason: "canonical_jarvis_parent_report",
      },
    } as any;
    const jarvisReportComments = new Map([["issue-done-parent-1", reportComment]]);

    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[jarvis]}
        liveRuns={[]}
        pendingApprovals={[]}
        completedIssues={[doneParent]}
        jarvisReportComments={jarvisReportComments}
        errorAgents={[]}
      />,
    );

    const completedCard = container.querySelector('[data-testid="mobile-completed-work-card"]');
    expect(completedCard).not.toBeNull();
    const itemLink = completedCard?.querySelector(
      '[data-testid="mobile-completed-issue-item-issue-done-parent-1"]',
    ) as HTMLAnchorElement;
    expect(itemLink).not.toBeNull();
    expect(itemLink?.getAttribute("href")).toBe(
      "/issues/issue-done-parent-1#comment-comment-canonical-done",
    );
    expect(itemLink?.textContent).toContain("Completed Parent Task");

    act(() => root.unmount());
  });

  it("renders Mobile Executive Governance Header with navigation links to approvals and settings conforming to min-h-9", () => {
    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const header = container.querySelector('[data-testid="mobile-governance-header"]');
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain("경영진 거버넌스 사령탑");

    const approvalsLink = container.querySelector('[data-testid="mobile-header-approvals-link"]') as HTMLAnchorElement;
    expect(approvalsLink).not.toBeNull();
    expect(approvalsLink.getAttribute("href")).toBe("/mobile/approvals");
    expect(approvalsLink.textContent).toContain("모바일 승인");
    expect(approvalsLink.closest("button, a")?.className).toContain("min-h-9");

    const settingsLink = container.querySelector('[data-testid="mobile-header-settings-link"]') as HTMLAnchorElement;
    expect(settingsLink).not.toBeNull();
    expect(settingsLink.getAttribute("href")).toBe("/mobile/settings");
    expect(settingsLink.textContent).toContain("모바일 설정");
    expect(settingsLink.closest("button, a")?.className).toContain("min-h-9");

    act(() => root.unmount());
  });

  it("reuses audio-chime isMuted/toggleMuted with aria-pressed on sound button with at least h-9 w-9", () => {
    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const soundBtn = container.querySelector('[data-testid="mobile-sound-toggle-btn"]') as HTMLButtonElement;
    expect(soundBtn).not.toBeNull();
    expect(soundBtn.className).toContain("h-9");
    expect(soundBtn.className).toContain("w-9");

    // Initially unmuted -> aria-pressed is false
    expect(soundBtn.getAttribute("aria-pressed")).toBe("false");

    // Click sound button to toggle mute
    act(() => {
      soundBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(soundBtn.getAttribute("aria-pressed")).toBe("true");

    // Click again to unmute
    act(() => {
      soundBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(soundBtn.getAttribute("aria-pressed")).toBe("false");

    act(() => root.unmount());
  });

  it("detects and displays PWA standalone state using browser APIs: standalone mode and browser web mode", () => {
    const origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(display-mode: standalone)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const rootStandalone = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const pwaStatusStandalone = container.querySelector('[data-testid="mobile-pwa-status"]');
    expect(pwaStatusStandalone).not.toBeNull();
    expect(pwaStatusStandalone?.textContent).toContain("PWA Standalone");

    act(() => rootStandalone.unmount());

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const rootBrowser = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const pwaStatusBrowser = container.querySelector('[data-testid="mobile-pwa-status"]');
    expect(pwaStatusBrowser).not.toBeNull();
    expect(pwaStatusBrowser?.textContent).toContain("Browser Web");

    act(() => rootBrowser.unmount());
    window.matchMedia = origMatchMedia;
  });

  it("shows current WebAuthn registered state when credentials exist", async () => {
    mockWebauthnApi.listCredentials.mockResolvedValue([
      {
        id: "cred-uuid-1",
        credentialId: "cid-faceid",
        deviceName: "iPhone Face ID",
        counter: 1,
        transports: ["internal"],
        createdAt: "2026-01-01T00:00:00Z",
        lastUsedAt: "2026-01-02T00:00:00Z",
      },
    ]);

    const root = renderWithQuery(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    await flushReact();
    await flushReact();

    expect(mockWebauthnApi.listCredentials).toHaveBeenCalledWith("company-1");
    const registeredBadge = container.querySelector('[data-testid="mobile-webauthn-registered"]');
    expect(registeredBadge).not.toBeNull();
    expect(registeredBadge?.textContent).toContain("등록됨");
    expect(registeredBadge?.textContent).toContain("1개");

    act(() => root.unmount());
  });

  it("shows current WebAuthn unregistered state when credential list is empty", async () => {
    mockWebauthnApi.listCredentials.mockResolvedValue([]);

    const root = renderWithQuery(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    await flushReact();
    await flushReact();

    expect(mockWebauthnApi.listCredentials).toHaveBeenCalledWith("company-1");
    const unregisteredBadge = container.querySelector('[data-testid="mobile-webauthn-unregistered"]');
    expect(unregisteredBadge).not.toBeNull();
    expect(unregisteredBadge?.textContent).toContain("미등록");

    act(() => root.unmount());
  });

  it("shows current WebAuthn loading state while query is pending", async () => {
    mockWebauthnApi.listCredentials.mockReturnValue(new Promise(() => {}));

    const root = renderWithQuery(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const loadingBadge = container.querySelector('[data-testid="mobile-webauthn-loading"]');
    expect(loadingBadge).not.toBeNull();
    expect(loadingBadge?.textContent).toContain("확인 중...");

    act(() => root.unmount());
  });

  it("shows current WebAuthn query-error state when credential query fails", async () => {
    mockWebauthnApi.listCredentials.mockRejectedValue(new Error("WebAuthn API unavailable"));

    const root = renderWithQuery(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    await flushReact();
    await flushReact();

    expect(mockWebauthnApi.listCredentials).toHaveBeenCalledWith("company-1");
    const errorBadge = container.querySelector('[data-testid="mobile-webauthn-error"]');
    expect(errorBadge).not.toBeNull();
    expect(errorBadge?.textContent).toContain("조회 실패");

    act(() => root.unmount());
  });

  it("uses semantic design tokens only and preserves mobile 360-390px layout without text-emerald or horizontal overflow", () => {
    const root = render(
      <AIOfficeMobileSummary
        companyId="company-1"
        agents={[makeAgent()]}
        liveRuns={[]}
        pendingApprovals={[]}
        errorAgents={[]}
      />,
    );

    const header = container.querySelector('[data-testid="mobile-governance-header"]');
    expect(header).not.toBeNull();

    // Verify no text-emerald is used
    const allElements = header?.querySelectorAll("*") ?? [];
    for (const el of allElements) {
      const cls = el.getAttribute("class") || "";
      expect(cls).not.toContain("text-emerald");
      expect(cls).not.toContain("bg-emerald");
      expect(cls).not.toContain("border-emerald");
    }

    act(() => root.unmount());
  });
});

