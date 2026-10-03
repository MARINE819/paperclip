// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHeartbeatsApi = vi.hoisted(() => ({
  neuralRoutes: vi.fn(),
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

import { JarvisNeuralCommandInterface } from "./JarvisNeuralCommandInterface";
import { ExecutionRoutePanel } from "./ExecutionRoutePanel";
import { MobileNeuralNavigator } from "./MobileNeuralNavigator";
import { CentralJarvisCore } from "./CentralJarvisCore";
import { AgentStatusNode } from "./AgentStatusNode";
import { NEURAL_ROUTE_FIXTURES, type NeuralExecutionRoute } from "./neuralCommandTypes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("JarvisNeuralCommandInterface — Phase 1 Frontend Foundation", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    // Phase 2B MVP: useNeuralCommandData now calls useQuery internally
    // (disabled unless a companyId is passed), which requires a
    // QueryClientProvider ancestor even when the query never actually fires.
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockHeartbeatsApi.neuralRoutes.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  function withQueryClient(node: ReactElement) {
    return <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
  }

  const MOCK_AGENTS = [
    { id: "agent-pm-1", name: "윤지우", title: "PM", role: "기획·전략팀장", orgUnitId: "team-planning", status: "running" },
    { id: "agent-dev-1", name: "백지수", title: "Knowledge", role: "지식관리", orgUnitId: "team-dev", status: "running" },
    { id: "agent-audit-1", name: "임도현", title: "Audit", role: "시스템감시", orgUnitId: "team-finance", status: "approval_waiting" },
    { id: "agent-qa-1", name: "정하은", title: "QA", role: "품질보증", orgUnitId: "team-qa", status: "failed" },
    { id: "agent-jarvis-core", name: "JARVIS", title: "CTO", role: "오케스트레이터", orgUnitId: "team-exec", status: "done" },
  ];

  const MOCK_ORG_UNITS = [
    { orgUnitId: "team-planning", name: "기획·전략팀" },
    { orgUnitId: "team-dev", name: "개발팀" },
    { orgUnitId: "team-finance", name: "재무·관리팀" },
    { orgUnitId: "team-qa", name: "QA·품질팀" },
    { orgUnitId: "team-exec", name: "경영진 / 비서실" },
  ];

  it("renders CentralJarvisCore with correct status and global metrics", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <CentralJarvisCore
          status="running"
          teamCount={5}
          agentCount={12}
          activeTaskCount={4}
          pendingApprovalCount={2}
        />,
      );
    });

    expect(container.textContent).toContain("JARVIS Core");
    expect(container.textContent).toContain("실행 중");
    expect(container.textContent).toContain("5개");
    expect(container.textContent).toContain("12명");
    expect(container.textContent).toContain("4건");
    expect(container.textContent).toContain("2건");
    act(() => root.unmount());
  });

  it("renders ExecutionRoutePanel with selected Executor, Provider, and Model", () => {
    const fixture = NEURAL_ROUTE_FIXTURES["exec-run-1"]!;
    const root = createRoot(container);
    act(() => {
      root.render(<ExecutionRoutePanel route={fixture} />);
    });

    expect(container.querySelector("[data-testid='executor-node']")?.textContent).toContain(fixture.executor);
    expect(container.querySelector("[data-testid='provider-node']")?.textContent?.toLowerCase()).toContain(fixture.provider.toLowerCase());
    expect(container.querySelector("[data-testid='model-node']")?.textContent).toContain(fixture.model);
    expect(container.textContent).toContain("티어 적합 매칭");
    expect(container.textContent).toContain("T3");
    act(() => root.unmount());
  });

  it("renders FallbackIndicator when fallback is used", () => {
    const fallbackRoute = NEURAL_ROUTE_FIXTURES["exec-fallback-3"]!;
    const root = createRoot(container);
    act(() => {
      root.render(<ExecutionRoutePanel route={fallbackRoute} />);
    });

    const fallbackElem = container.querySelector("[data-testid='fallback-indicator']");
    expect(fallbackElem).not.toBeNull();
    expect(fallbackElem?.textContent).toContain("폴백 재시도 이력");
    expect(fallbackElem?.textContent).toContain("codex_local");
    expect(fallbackElem?.textContent).toContain("rate_limited");
    act(() => root.unmount());
  });

  it("renders ApprovalWaitingIndicator when status is approval_waiting", () => {
    const approvalRoute = NEURAL_ROUTE_FIXTURES["exec-approval-2"]!;
    const root = createRoot(container);
    act(() => {
      root.render(<ExecutionRoutePanel route={approvalRoute} />);
    });

    const approvalIndicator = container.querySelector("[data-testid='approval-waiting-indicator']");
    expect(approvalIndicator).not.toBeNull();
    expect(approvalIndicator?.textContent).toContain("Approval Gate 승인 대기 중");
    expect(approvalIndicator?.textContent).toContain("보존 기간 만료 데이터");
    expect(approvalIndicator?.textContent?.toLowerCase()).toContain("high risk");
    act(() => root.unmount());
  });

  it("renders IncidentStateIndicator and failed state when incident is detected", () => {
    const failedRoute = NEURAL_ROUTE_FIXTURES["exec-failed-4"]!;
    const root = createRoot(container);
    act(() => {
      root.render(<ExecutionRoutePanel route={failedRoute} />);
    });

    const incidentElem = container.querySelector("[data-testid='incident-state-indicator']");
    expect(incidentElem).not.toBeNull();
    expect(incidentElem?.textContent).toContain("SRE 인시던트 연관 감지");
    expect(incidentElem?.textContent).toContain("windows_control_c_exit_detected");
    expect(container.querySelector("[data-testid='execution-status-badge']")?.textContent).toContain("실패");
    act(() => root.unmount());
  });

  it("renders done state correctly", () => {
    const doneRoute = NEURAL_ROUTE_FIXTURES["exec-done-5"]!;
    const root = createRoot(container);
    act(() => {
      root.render(<ExecutionRoutePanel route={doneRoute} />);
    });

    expect(container.querySelector("[data-testid='execution-status-badge']")?.textContent).toContain("완료");
    act(() => root.unmount());
  });

  it("displays BACKEND_INTEGRATION_PENDING banner clearly", () => {
    const fixture = NEURAL_ROUTE_FIXTURES["exec-run-1"]!;
    const root = createRoot(container);
    act(() => {
      root.render(<ExecutionRoutePanel route={fixture} />);
    });

    const banner = container.querySelector("[data-testid='backend-pending-banner']");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("BACKEND_INTEGRATION_PENDING");
    act(() => root.unmount());
  });

  it("executes mobile staged drill-down navigation (Core -> Team -> Agent -> Execution)", () => {
    const routesByAgent = new Map<string, NeuralExecutionRoute>([
      ["agent-pm-1", NEURAL_ROUTE_FIXTURES["exec-run-1"]!],
    ]);

    const mockTeams = [
      {
        id: "team-planning",
        name: "기획·전략팀",
        agentIds: ["agent-pm-1"],
        activeTaskCount: 1,
        hasApprovalWaiting: false,
        hasFailure: false,
      },
    ];

    let selectedTeam: string | null = null;
    let selectedAgent: string | null = null;

    const root = createRoot(container);
    act(() => {
      root.render(
        <MobileNeuralNavigator
          teams={mockTeams}
          agents={MOCK_AGENTS}
          routesByAgentId={routesByAgent}
          selectedTeamId={selectedTeam}
          selectedAgentId={selectedAgent}
          onSelectTeam={(t) => { selectedTeam = t; }}
          onSelectAgent={(a) => { selectedAgent = a; }}
        />,
      );
    });

    // Step 1: Initial stage is "core"
    expect(container.querySelector("[data-testid='mobile-stage-core']")).not.toBeNull();
    expect(container.textContent).toContain("기획·전략팀");

    // Click team button to advance to "team" stage
    const teamBtn = container.querySelector("[data-testid='mobile-team-btn-team-planning']") as HTMLButtonElement;
    expect(teamBtn).not.toBeNull();

    act(() => {
      teamBtn.click();
    });

    // Re-render with updated selectedTeamId
    act(() => {
      root.render(
        <MobileNeuralNavigator
          teams={mockTeams}
          agents={MOCK_AGENTS}
          routesByAgentId={routesByAgent}
          selectedTeamId="team-planning"
          selectedAgentId={selectedAgent}
          onSelectTeam={(t) => { selectedTeam = t; }}
          onSelectAgent={(a) => { selectedAgent = a; }}
        />,
      );
    });

    // Step 2: Now on "team" stage showing agent
    expect(container.querySelector("[data-testid='mobile-stage-team']")).not.toBeNull();
    expect(container.textContent).toContain("윤지우");

    // Click agent to advance to "execution" stage
    const agentNode = container.querySelector("[data-testid='agent-node-agent-pm-1']") as HTMLButtonElement;
    expect(agentNode).not.toBeNull();

    act(() => {
      agentNode.click();
    });

    // Re-render with updated selectedAgentId
    act(() => {
      root.render(
        <MobileNeuralNavigator
          teams={mockTeams}
          agents={MOCK_AGENTS}
          routesByAgentId={routesByAgent}
          selectedTeamId="team-planning"
          selectedAgentId="agent-pm-1"
          onSelectTeam={(t) => { selectedTeam = t; }}
          onSelectAgent={(a) => { selectedAgent = a; }}
        />,
      );
    });

    // Step 3/4: Now on "execution" stage showing ExecutionRoutePanel
    expect(container.querySelector("[data-testid='mobile-stage-execution']")).not.toBeNull();
    expect(container.querySelector("[data-testid='execution-route-panel']")).not.toBeNull();

    act(() => root.unmount());
  });

  it("renders generic data faithfully without hardcoding specific AI roles", () => {
    // Custom dynamic route that does NOT match conventional stereotypes
    const customRoute: NeuralExecutionRoute = {
      id: "custom-route-99",
      taskTitle: "임의의 사용자 정의 알고리즘 연산",
      agentId: "agent-custom",
      agentName: "테스트봇",
      teamName: "임시부서",
      status: "running",
      executor: "custom_hardware_accelerator",
      provider: "open_router_proxy",
      model: "mistral-large-instruct",
      difficultyTier: "T1",
      selectionReason: "cost_optimized_routing",
      capabilityMatch: ["matrix_multiplication"],
      verificationStatus: "testing",
      fallbackUsed: false,
      costClass: "low",
      latencyClass: "fast",
      routerVersion: 1,
      backendIntegrationPending: true,
    };

    const root = createRoot(container);
    act(() => {
      root.render(<ExecutionRoutePanel route={customRoute} />);
    });

    expect(container.textContent).toContain("custom_hardware_accelerator");
    expect(container.textContent).toContain("open_router_proxy");
    expect(container.textContent).toContain("mistral-large-instruct");
    expect(container.textContent).toContain("cost_optimized_routing");
    expect(container.textContent).toContain("matrix_multiplication");
    act(() => root.unmount());
  });

  it("mounts full JarvisNeuralCommandInterface with teams and default route", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        withQueryClient(
          <JarvisNeuralCommandInterface
            agents={MOCK_AGENTS}
            orgUnits={MOCK_ORG_UNITS}
          />,
        ),
      );
    });

    expect(container.querySelector("[data-testid='jarvis-neural-command-interface']")).not.toBeNull();
    expect(container.textContent).toContain("JARVIS Neural Command Map");
    expect(container.textContent).toContain("부서 / 조직 네트워크 (Team Ring)");
    expect(container.querySelector("[data-testid='backend-pending-banner']")).not.toBeNull();
    act(() => root.unmount());
  });

  it("renders loading state cleanly with accessible aria-busy and spinner", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        withQueryClient(
          <JarvisNeuralCommandInterface
            agents={MOCK_AGENTS}
            isLoading={true}
          />,
        ),
      );
    });

    const loadingElem = container.querySelector("[data-testid='neural-loading-state']");
    expect(loadingElem).not.toBeNull();
    expect(loadingElem?.getAttribute("role")).toBe("status");
    expect(loadingElem?.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("JARVIS 지휘 신경망 데이터 로딩 중");
    act(() => root.unmount());
  });

  it("renders error state cleanly with accessible alert role", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        withQueryClient(
          <JarvisNeuralCommandInterface
            agents={MOCK_AGENTS}
            error="원격 라우팅 소켓 연결 실패 (503)"
          />,
        ),
      );
    });

    const errorElem = container.querySelector("[data-testid='neural-error-state']");
    expect(errorElem).not.toBeNull();
    expect(errorElem?.getAttribute("role")).toBe("alert");
    expect(container.textContent).toContain("신경망 관측 데이터 조회 오류");
    expect(container.textContent).toContain("원격 라우팅 소켓 연결 실패 (503)");
    act(() => root.unmount());
  });

  it("renders empty state cleanly when zero agents and zero org units", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        withQueryClient(
          <JarvisNeuralCommandInterface
            agents={[]}
            orgUnits={[]}
          />,
        ),
      );
    });

    const emptyElem = container.querySelector("[data-testid='neural-empty-state']");
    expect(emptyElem).not.toBeNull();
    expect(container.textContent).toContain("등록된 부서 또는 에이전트가 없습니다");
    act(() => root.unmount());
  });

  it("fixture mode shows simulation badge and pending banner, never falsely labeled live", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        withQueryClient(
          <JarvisNeuralCommandInterface
            agents={MOCK_AGENTS}
            orgUnits={MOCK_ORG_UNITS}
            sourceOverride="fixture"
          />,
        ),
      );
    });

    const badge = container.querySelector("[data-testid='neural-source-badge']");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("시뮬레이션 픽스처");
    expect(badge?.textContent).not.toContain("운영 라이브");
    expect(container.querySelector("[data-testid='backend-pending-banner']")).not.toBeNull();
    act(() => root.unmount());
  });

  it("even with sourceOverride='live', pending banner remains visible and fixture is not labeled live", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        withQueryClient(
          <JarvisNeuralCommandInterface
            agents={MOCK_AGENTS}
            orgUnits={MOCK_ORG_UNITS}
            sourceOverride="live"
          />,
        ),
      );
    });

    const badge = container.querySelector("[data-testid='neural-source-badge']");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).not.toContain("운영 라이브");
    expect(badge?.textContent).toContain("시뮬레이션 픽스처");
    // In Phase 2A, pending banner MUST remain visible because LIVE_MODE_IMPLEMENTED=NO
    expect(container.querySelector("[data-testid='backend-pending-banner']")).not.toBeNull();
    act(() => root.unmount());
  });

  it("without a companyId prop, never calls the backend neural-routes endpoint (fixture behavior unchanged)", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        withQueryClient(
          <JarvisNeuralCommandInterface agents={MOCK_AGENTS} orgUnits={MOCK_ORG_UNITS} />,
        ),
      );
    });

    expect(mockHeartbeatsApi.neuralRoutes).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='backend-pending-banner']")).not.toBeNull();
    act(() => root.unmount());
  });

  it("with a companyId prop and a successful backend response, reaches the live query path and clears the pending banner", async () => {
    mockHeartbeatsApi.neuralRoutes.mockResolvedValue([
      {
        runId: "run-live-1",
        companyId: "company-wired-1",
        agentId: "agent-pm-1",
        routedExecutor: "codex_local",
        actualExecutor: "codex_local",
        routingReason: "tier_routing",
        status: "running",
        startedAt: "2026-10-01T00:00:00.000Z",
        source: "live",
        provider: null,
        model: null,
      },
    ]);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        withQueryClient(
          <JarvisNeuralCommandInterface
            agents={MOCK_AGENTS}
            orgUnits={MOCK_ORG_UNITS}
            companyId="company-wired-1"
          />,
        ),
      );
    });
    // Flush the queryFn promise and the resulting re-render(s).
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    expect(mockHeartbeatsApi.neuralRoutes).toHaveBeenCalledWith("company-wired-1");
    expect(container.querySelector("[data-testid='backend-pending-banner']")).toBeNull();
    const badge = container.querySelector("[data-testid='neural-source-badge']");
    expect(badge?.textContent).toContain("실시간");
    act(() => root.unmount());
  });
});
