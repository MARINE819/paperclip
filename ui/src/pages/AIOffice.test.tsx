// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Approval, OrgUnitStatus } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { AIOffice } from "./AIOffice";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  orgUnitsStatus: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
  neuralRoutes: vi.fn(),
}));

const mockApprovalsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockCostsApi = vi.hoisted(() => ({
  byAgentModel: vi.fn(),
  byProvider: vi.fn(),
  quotaWindows: vi.fn(),
}));

const mockAiOfficeApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
}));

const mockCompaniesApi = vi.hoisted(() => ({
  emergencyPause: vi.fn(),
}));

const mockEvalsApi = vi.hoisted(() => ({
  listBenchmarks: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  getSummary: vi.fn(),
  getAgentSummary: vi.fn(),
}));

const mockIncidentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockDataLifecycleApi = vi.hoisted(() => ({
  policies: vi.fn(),
  summary: vi.fn(),
  dryRun: vi.fn(),
}));

const mockToolTrustApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
}));

const mockSecretsRegistryApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
}));

const mockKnowledgeApi = vi.hoisted(() => ({
  listMemoryOperations: vi.fn(),
  getMemoryOperation: vi.fn(),
  reviewMemoryOperation: vi.fn(),
  promoteMemoryOperation: vi.fn(),
  listKnowledgeRecords: vi.fn(),
  getKnowledgeRecord: vi.fn(),
  syncKnowledgeRecord: vi.fn(),
}));

const mockBackupApi = vi.hoisted(() => ({
  getHealth: vi.fn(),
  runManualBackup: vi.fn(),
}));

vi.mock("../api/backup", () => ({
  backupApi: mockBackupApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../api/costs", () => ({
  costsApi: mockCostsApi,
}));

vi.mock("../api/aiOffice", () => ({
  aiOfficeApi: mockAiOfficeApi,
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../api/evals", () => ({
  evalsApi: mockEvalsApi,
}));

vi.mock("../api/incidents", () => ({
  incidentsApi: mockIncidentsApi,
}));

vi.mock("../api/data-lifecycle", () => ({
  dataLifecycleApi: mockDataLifecycleApi,
}));

vi.mock("../api/tool-trust", () => ({
  toolTrustApi: mockToolTrustApi,
}));

vi.mock("../api/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/secrets")>()),
  secretsRegistryApi: mockSecretsRegistryApi,
}));

vi.mock("../api/knowledge", () => ({
  knowledgeApi: mockKnowledgeApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// ActivityFeed and DecisionQueueRail pull in their own heavy query/router
// wiring that isn't relevant to this page's own logic — stub them so this
// file only tests AIOffice's own composition, not their internals.
vi.mock("../components/ActivityFeed", () => ({
  ActivityFeed: () => <div data-testid="activity-feed-stub" />,
}));
vi.mock("../components/DecisionQueueRail", () => ({
  DecisionQueueRail: () => <div data-testid="decision-queue-rail-stub" />,
}));
vi.mock("../components/VoiceCommandBar", () => ({
  VoiceCommandBar: () => <div data-testid="voice-command-bar-stub" />,
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

function makeOrgUnitStatus(overrides: Partial<OrgUnitStatus> = {}): OrgUnitStatus {
  return {
    orgUnitId: "org-unit-1",
    name: "비서실",
    agentCount: 1,
    activeCount: 1,
    runningCount: 0,
    errorCount: 0,
    currentTaskCount: 0,
    ...overrides,
  };
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

const HEALTHY_STATUS = {
  timestamp: "2026-09-19T12:00:00.000Z",
  supervisor: { status: "running" as const, pid: 1234, uptimeSeconds: 3600 },
  database: {
    mode: "embedded-postgres" as const,
    status: "healthy" as const,
    port: 54329,
    activeConnections: 3,
    connectionUrlSanitized: "postgres://paperclip:***@127.0.0.1:54329/paperclip",
  },
  server: { status: "healthy" as const, version: "1.0.0", listenHost: "127.0.0.1", listenPort: 3100 },
  backup: {
    enabled: true,
    backupDir: "/backups",
    latestBackupName: "paperclip-20260919-000000.sql.gz",
    latestBackupTime: "2026-09-19T00:00:00.000Z",
    status: "ok" as const,
    databaseBackupMaxAgeHours: 24,
  },
};

describe("AIOffice", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockHeartbeatsApi.neuralRoutes.mockResolvedValue([]);
    mockApprovalsApi.list.mockResolvedValue([]);
    mockCostsApi.byAgentModel.mockResolvedValue([]);
    mockCostsApi.byProvider.mockResolvedValue([]);
    mockCostsApi.quotaWindows.mockResolvedValue([]);
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockCompaniesApi.emergencyPause.mockResolvedValue({});
    mockEvalsApi.listBenchmarks.mockResolvedValue({ benchmarks: [] });
    mockEvalsApi.listRuns.mockResolvedValue({ runs: [] });
    mockEvalsApi.getSummary.mockResolvedValue({ summary: [] });
    mockEvalsApi.getAgentSummary.mockResolvedValue({
      agent: {
        agentId: "agent-1",
        latestEval: null,
        passRate: null,
        avgLatencyMs: null,
        avgCost: null,
        recentRegression: null,
        recentRuns: [],
      },
    });
    mockIncidentsApi.list.mockResolvedValue({ open: [], resolved: [] });
    mockDataLifecycleApi.policies.mockResolvedValue({ policies: [] });
    mockDataLifecycleApi.summary.mockResolvedValue({ classifications: [] });
    mockDataLifecycleApi.dryRun.mockResolvedValue({
      result: {
        dataClass: "audit",
        source: "activityLog",
        action: "none",
        candidateCount: 0,
        oldestCandidate: null,
        newestCandidate: null,
        estimatedRows: 0,
        reason: "no_policy_configured",
      },
    });
    mockToolTrustApi.list.mockResolvedValue({ entries: [] });
    mockSecretsRegistryApi.list.mockResolvedValue({ entries: [] });
    mockKnowledgeApi.listMemoryOperations.mockResolvedValue([]);
    mockKnowledgeApi.listKnowledgeRecords.mockResolvedValue([]);
    mockBackupApi.getHealth.mockResolvedValue({
      enabled: true,
      status: "ok",
      backupDir: "/backups",
      maxAgeHours: 26,
      latestBackup: null,
      latestRecoveryArtifact: null,
      lastFailure: null,
      warnings: [],
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AIOffice />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  // "empty" now means "the query genuinely resolved with 0 rows" and must
  // render a dedicated notice instead of the floor plan — so any test that
  // wants to see the floor plan itself needs at least one real agent/org
  // unit in the mocks to reach the "ready" state.
  it("mounts the F-02 read-only secrets registry when security tab is active", async () => {
    window.history.replaceState({}, "", "/ai-office?tab=security");
    const root = await renderPage();
    expect(container.textContent).toContain("Control Center — Secrets & Credentials (F-02)");
    expect(mockSecretsRegistryApi.list).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("비밀 값은 표시되지 않습니다.");
    act(() => root.unmount());
  });

  it("mounts only active tab Labs by default (SRE) and lazy mounts other tabs on demand", async () => {
    window.history.replaceState({}, "", "/ai-office");
    const root = await renderPage();

    // Default tab is SRE (F-06 Incident Lab and F-03 Backup DR Lab mounted)
    expect(container.textContent).toContain("Control Center — Incident & SRE Center (F-06)");
    expect(container.textContent).toContain("Control Center — Backup & Disaster Recovery (F-03)");
    // Other tabs are NOT mounted on initial load (lazy mounting)
    expect(container.textContent).not.toContain("Control Center — Secrets & Credentials (F-02)");
    expect(container.textContent).not.toContain("Control Center — Agent Quality & Simulation Lab (F-04)");
    expect(container.textContent).not.toContain("Control Center — Knowledge & Memory (F-07 / F-08)");

    // Switch to Quality tab
    const qualityTab = container.querySelector('[data-testid="control-center-tab-quality"]') as HTMLButtonElement;
    act(() => qualityTab.click());
    await flushReact();

    expect(container.textContent).toContain("Control Center — Agent Quality & Simulation Lab (F-04)");
    expect(container.textContent).not.toContain("Control Center — Incident & SRE Center (F-06)");
    expect(container.textContent).not.toContain("Control Center — Backup & Disaster Recovery (F-03)");

    // Switch to All tab
    const allTab = container.querySelector('[data-testid="control-center-tab-all"]') as HTMLButtonElement;
    act(() => allTab.click());
    await flushReact();

    // All Labs are mounted in "all" view
    expect(container.textContent).toContain("Control Center — Incident & SRE Center (F-06)");
    expect(container.textContent).toContain("Control Center — Backup & Disaster Recovery (F-03)");
    expect(container.textContent).toContain("Control Center — Secrets & Credentials (F-02)");
    expect(container.textContent).toContain("Control Center — Agent Quality & Simulation Lab (F-04)");
    expect(container.textContent).toContain("Control Center — Knowledge & Memory (F-07 / F-08)");

    act(() => root.unmount());
  });

  it("renders an office layout (rooms, not a plain card dashboard) with leadership seats", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "someone", name: "Someone", orgUnitId: null })]);
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([makeOrgUnitStatus()]);
    const root = await renderPage();

    expect(container.textContent).toContain("AI Office");
    expect(container.textContent).toContain("CEO실");
    expect(container.textContent).toContain("서대곤");
    expect(container.textContent).toContain("JARVIS 워크스테이션");
    expect(container.textContent).toContain("COO석");
    expect(container.textContent).toContain("회의실");
    expect(container.textContent).toContain("라운지");
    // Unlinked JARVIS/Atlas must say so, never fabricate a working state.
    expect(container.textContent).toContain("미연결");

    act(() => root.unmount());
  });

  it("renders exactly the 8 fixed Master 1차 department rooms, no more, no less", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "someone", name: "Someone", orgUnitId: null })]);
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([makeOrgUnitStatus()]);
    const root = await renderPage();

    for (const label of ["비서실", "개발팀", "기획·전략팀", "QA팀", "영업팀", "회계·재무팀", "법무팀", "교육팀"]) {
      expect(container.textContent).toContain(label);
    }

    act(() => root.unmount());
  });

  it("shows a real JARVIS agent's actual error status, relabeled as CTO, without hiding it", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "jarvis-1", name: "JARVIS", role: "ceo", status: "error" }),
    ]);
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([makeOrgUnitStatus()]);
    const root = await renderPage();

    expect(container.textContent).toContain("오류/차단");
    expect(container.textContent).not.toContain("CEO — JARVIS");

    act(() => root.unmount());
  });

  it("separates real org_units outside the 8 fixed rooms into a distinct 기타/미배정 section", async () => {
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([
      makeOrgUnitStatus({ orgUnitId: "sec-1", name: "운영·인프라팀" }),
    ]);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "ops-1", name: "Ops-Bot", orgUnitId: "sec-1", status: "idle" }),
    ]);
    const root = await renderPage();

    expect(container.textContent).toContain("기타 / 미배정 조직");
    expect(container.textContent).toContain("운영·인프라팀");
    expect(container.textContent).toContain("Ops-Bot");

    act(() => root.unmount());
  });

  it("shows a real department agent's live status and task summary under its mapped room", async () => {
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([makeOrgUnitStatus({ orgUnitId: "dev-1", name: "개발팀" })]);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "dev-agent-1", name: "Beta", orgUnitId: "dev-1", status: "running" }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ agentId: "dev-agent-1", currentStatusMessage: "Refactoring the payments module" }),
    ]);
    const root = await renderPage();

    expect(container.textContent).toContain("Beta");
    expect(container.textContent).toContain("업무 중");

    act(() => root.unmount());
  });

  it("lists a real agent under 블로커 센터 when it is in an error or offline condition", async () => {
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([makeOrgUnitStatus({ orgUnitId: "dev-1", name: "개발팀" })]);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "broken-1", name: "Broken-Agent", orgUnitId: "dev-1", status: "error" }),
    ]);
    const root = await renderPage();

    expect(container.textContent).toContain("블로커 센터");
    expect(container.textContent).toContain("Broken-Agent");

    act(() => root.unmount());
  });

  it("shows real usage totals under 사용량 TOP, never a fabricated performance score", async () => {
    mockCostsApi.byAgentModel.mockResolvedValue([
      { agentId: "a1", agentName: "Alpha", provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt", costCents: 500, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    ]);
    const root = await renderPage();

    expect(container.textContent).toContain("사용량 TOP");
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("$5.00");
    expect(container.textContent).not.toContain("성과 점수");

    act(() => root.unmount());
  });

  it("shows Model Router as not-yet-integrated rather than fabricating a metric", async () => {
    const root = await renderPage();
    expect(container.textContent).toContain("Model Router 성과");
    expect(container.textContent).toContain("연동 예정");
    act(() => root.unmount());
  });

  it("does NOT call emergencyPause on the first Emergency Stop click — only after confirming", async () => {
    const root = await renderPage();

    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Emergency Stop",
    )!;
    act(() => stopButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    // AlertDialog renders through a Radix portal into document.body, not
    // into our local `container` — assert against the full document.
    expect(mockCompaniesApi.emergencyPause).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("회사 전체를 긴급 정지하시겠습니까?");

    act(() => root.unmount());
  });

  it("calls emergencyPause only after the final confirm action is clicked", async () => {
    const root = await renderPage();

    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Emergency Stop",
    )!;
    act(() => stopButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    const confirmButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Emergency Stop 실행",
    )!;
    act(() => confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    expect(mockCompaniesApi.emergencyPause).toHaveBeenCalledTimes(1);
    expect(mockCompaniesApi.emergencyPause).toHaveBeenCalledWith("company-1");

    act(() => root.unmount());
  });

  it("renders the Voice entry point via the reused VoiceCommandBar", async () => {
    const root = await renderPage();
    expect(container.querySelector('[data-testid="voice-command-bar-stub"]')).not.toBeNull();
    act(() => root.unmount());
  });

  // ── Live data diagnostic: loading/error/empty must never collapse into a
  // silent "미연결/공석" — each state has to be visible and distinguishable.

  it("shows the real org_unit fetch error message instead of a silent 미연결", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "someone", name: "Someone" })]);
    mockAgentsApi.orgUnitsStatus.mockRejectedValue(new Error("org-units endpoint returned 500"));
    const root = await renderPage();

    expect(container.textContent).toContain("조직 데이터 조회 실패");
    expect(container.textContent).toContain("org-units endpoint returned 500");
    // The failure must not be mistaken for a legitimate empty/unlinked room.
    expect(container.textContent).not.toContain("비서실");

    act(() => root.unmount());
  });

  it("shows the real agents fetch error message instead of a silent 미연결", async () => {
    mockAgentsApi.list.mockRejectedValue(new Error("agents endpoint returned 500"));
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([makeOrgUnitStatus()]);
    const root = await renderPage();

    expect(container.textContent).toContain("에이전트 데이터 조회 실패");
    expect(container.textContent).toContain("agents endpoint returned 500");
    expect(container.textContent).not.toContain("비서실");

    act(() => root.unmount());
  });

  it("shows a loading notice while queries are in flight, never a fabricated 미연결", async () => {
    mockAgentsApi.list.mockReturnValue(new Promise(() => {}));
    mockAgentsApi.orgUnitsStatus.mockReturnValue(new Promise(() => {}));
    const root = await renderPage();

    expect(container.textContent).toContain("조직 데이터 로딩 중");
    // The floor plan itself (leadership seats, department rooms) must not
    // render at all while loading — proving no per-seat 미연결 badge could
    // have been fabricated. (The intro paragraph's own copy mentions
    // "미연결/배정 대기" generically, so those substrings aren't checked here.)
    expect(container.textContent).not.toContain("CEO실");

    act(() => root.unmount());
  });

  it("still renders the office floor (leadership seats, per-room empty notes) when org units genuinely resolve empty — org data alone must not blank the whole floor", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "someone", name: "Someone" })]);
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([]);
    const root = await renderPage();

    // Leadership seats never depended on org-unit data — they must still render.
    expect(container.textContent).toContain("CEO실");
    expect(container.textContent).toContain("JARVIS 워크스테이션");
    // Department rooms fall back to their own existing, honest per-room empty
    // notice instead of the blanket "조직 데이터 없음" that used to suppress
    // the entire floor (including leadership seats that don't need org data).
    expect(container.textContent).toContain("NEXORA 조직 확정 부서 — 아직 실제 org_unit 데이터 없음");
    expect(container.textContent).not.toContain("조직 데이터 없음");

    act(() => root.unmount());
  });

  it("renders the office floor normally once both agents and org units succeed with real data", async () => {
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([makeOrgUnitStatus({ orgUnitId: "dev-1", name: "개발팀" })]);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "dev-agent-1", name: "Delta", orgUnitId: "dev-1", status: "idle" }),
    ]);
    const root = await renderPage();

    expect(container.textContent).not.toContain("조직 데이터 로딩 중");
    expect(container.textContent).not.toContain("조직 데이터 조회 실패");
    expect(container.textContent).not.toContain("에이전트 데이터 없음");
    expect(container.textContent).toContain("Delta");
    expect(container.textContent).toContain("CEO실");

    act(() => root.unmount());
  });

  // ── Living MVP: top-stats-vs-rendered-agents regression (F) ──
  // TOP STATS ROOT CAUSE remains UNRESOLVED per the CEO's explicit
  // instruction — this test only proves the invariant already holds in this
  // file's own logic (shared `agents` array), it does not "fix" anything.
  it("keeps the 전체 인원 stat consistent with the number of real agents actually rendered", async () => {
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([
      makeOrgUnitStatus({ orgUnitId: "dev-1", name: "개발팀" }),
      makeOrgUnitStatus({ orgUnitId: "sec-1", name: "비서실" }),
    ]);
    const mockedAgents = [
      makeAgent({ id: "a1", name: "Alpha-Agent", orgUnitId: "dev-1" }),
      makeAgent({ id: "a2", name: "Beta-Agent", orgUnitId: "sec-1" }),
    ];
    mockAgentsApi.list.mockResolvedValue(mockedAgents);
    const root = await renderPage();

    // (1) top stat value
    const totalStatLabel = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "전체 인원",
    )!;
    const totalStatValue = totalStatLabel.parentElement!.querySelector("span:last-child")!.textContent;
    expect(totalStatValue).toBe(String(mockedAgents.length));

    // (2) every mocked agent actually rendered as a Workstation
    for (const agent of mockedAgents) {
      expect(container.textContent).toContain(agent.name);
    }
    const renderedWorkstationCount = mockedAgents.filter((agent) =>
      container.textContent!.includes(agent.name),
    ).length;
    expect(renderedWorkstationCount).toBe(Number(totalStatValue));

    act(() => root.unmount());
  });

  it("opens the AgentDetailSheet with real data on Workstation click, without any new API call", async () => {
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([makeOrgUnitStatus({ orgUnitId: "dev-1", name: "개발팀" })]);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "dev-agent-1", name: "Gamma", orgUnitId: "dev-1", status: "running" }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ agentId: "dev-agent-1", currentStatusMessage: "Building the report" }),
    ]);
    const root = await renderPage();

    const listCallsBefore = mockAgentsApi.list.mock.calls.length;
    const liveRunCallsBefore = mockHeartbeatsApi.liveRunsForCompany.mock.calls.length;

    const workstationButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Gamma"),
    )!;
    act(() => workstationButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    // Sheet renders via a Radix portal into document.body. AI Office shows a
    // one-line current task when there is one, plus a link to the full
    // Dashboard-owned detail — it does not duplicate approval/blocked/issue
    // detail itself.
    expect(document.body.textContent).toContain("Gamma");
    expect(document.body.textContent).toContain("업무 중");
    expect(document.body.textContent).toContain("Building the report");
    expect(document.body.querySelector('a[href*="dev-agent-1"]')).not.toBeNull();

    expect(mockAgentsApi.list.mock.calls.length).toBe(listCallsBefore);
    expect(mockHeartbeatsApi.liveRunsForCompany.mock.calls.length).toBe(liveRunCallsBefore);

    act(() => root.unmount());
  });

  it("renders Atlas as a vacant seat (EmptySeat), never as a fabricated org or agent", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "someone", name: "Someone" })]);
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([makeOrgUnitStatus()]);
    const root = await renderPage();

    expect(container.textContent).toContain("COO석");
    expect(container.textContent).toContain("공석");
    expect(container.textContent).not.toContain("COO — Atlas");
    // Atlas's empty seat renders the same desk/chair shapes as a real
    // workstation, just with no employee.
    const cooRoom = Array.from(container.querySelectorAll("[data-room-type]")).find((el) =>
      el.textContent?.includes("COO석"),
    )!;
    expect(cooRoom.querySelector('[data-part="desk"]')).not.toBeNull();
    expect(cooRoom.querySelector('[data-part="agent"]')).toBeNull();

    act(() => root.unmount());
  });

  // ── "식물"/"구성" regression guard — root cause remains UNRESOLVED. This
  // only proves the full AI Office page's own render output never produces
  // these strings; it is not a claim about what the CEO's browser showed.
  it("never renders the literal strings 식물 or 구성 anywhere on the AI Office page", async () => {
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([
      makeOrgUnitStatus({ orgUnitId: "dev-1", name: "개발팀" }),
      makeOrgUnitStatus({ orgUnitId: "other-1", name: "운영·인프라팀" }),
    ]);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "jarvis-1", name: "JARVIS", role: "ceo", status: "error" }),
      makeAgent({ id: "dev-1", name: "Delta", orgUnitId: "dev-1" }),
      makeAgent({ id: "ops-1", name: "Ops-Bot", orgUnitId: "other-1" }),
    ]);
    const root = await renderPage();

    expect(container.textContent).not.toContain("식물");
    expect(container.textContent).not.toContain("구성");

    act(() => root.unmount());
  });

  // ── AI Office Status Count UX: 오류/차단 and 오프라인 Top Stats separation ──
  it("separates 오류/차단 and 오프라인 in Top Stats without double-counting", async () => {
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([
      makeOrgUnitStatus({ orgUnitId: "dev-1", name: "개발팀" }),
    ]);
    const errorAgent = makeAgent({ id: "err-1", name: "Err-Bot", orgUnitId: "dev-1", status: "error" });
    const offlineAgent = makeAgent({
      id: "off-1",
      name: "Off-Bot",
      orgUnitId: "dev-1",
      status: "idle",
      lastHeartbeatAt: null,
    });
    const idleAgent = makeAgent({
      id: "idle-1",
      name: "Idle-Bot",
      orgUnitId: "dev-1",
      status: "idle",
      lastHeartbeatAt: new Date(),
    });
    const workingAgent = makeAgent({
      id: "work-1",
      name: "Work-Bot",
      orgUnitId: "dev-1",
      status: "running",
      lastHeartbeatAt: new Date(),
    });
    mockAgentsApi.list.mockResolvedValue([errorAgent, offlineAgent, idleAgent, workingAgent]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ agentId: "work-1", agentName: "Work-Bot" }),
    ]);

    const root = await renderPage();

    const getStat = (label: string) => {
      const span = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === label);
      return span?.parentElement?.querySelector("span:last-child")?.textContent;
    };

    expect(getStat("전체 인원")).toBe("4");
    expect(getStat("업무 중")).toBe("1");
    expect(getStat("오류/차단")).toBe("1");
    expect(getStat("오프라인")).toBe("1");

    // Blocker center still lists both agents
    expect(container.textContent).toContain("블로커 센터");
    expect(container.textContent).toContain("Err-Bot");
    expect(container.textContent).toContain("Off-Bot");

    act(() => root.unmount());
  });

  it("prioritizes error over offline when an agent satisfies both conditions without double-counting", async () => {
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([
      makeOrgUnitStatus({ orgUnitId: "dev-1", name: "개발팀" }),
    ]);
    // Stale/null heartbeat + error status
    const dualConditionAgent = makeAgent({
      id: "dual-1",
      name: "Dual-Bot",
      orgUnitId: "dev-1",
      status: "error",
      lastHeartbeatAt: null,
    });
    mockAgentsApi.list.mockResolvedValue([dualConditionAgent]);

    const root = await renderPage();

    const getStat = (label: string) => {
      const span = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === label);
      return span?.parentElement?.querySelector("span:last-child")?.textContent;
    };

    expect(getStat("전체 인원")).toBe("1");
    expect(getStat("오류/차단")).toBe("1");
    expect(getStat("오프라인")).toBe("0");

    act(() => root.unmount());
  });

  it("does not classify active running agents or live runs as offline even with stale heartbeats", async () => {
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([
      makeOrgUnitStatus({ orgUnitId: "dev-1", name: "개발팀" }),
    ]);
    const staleTime = new Date(Date.now() - 60 * 60_000);
    const runningAgent = makeAgent({
      id: "run-1",
      name: "Running-Bot",
      orgUnitId: "dev-1",
      status: "running",
      lastHeartbeatAt: staleTime,
    });
    const liveRunAgent = makeAgent({
      id: "live-1",
      name: "Live-Bot",
      orgUnitId: "dev-1",
      status: "idle",
      lastHeartbeatAt: staleTime,
    });
    mockAgentsApi.list.mockResolvedValue([runningAgent, liveRunAgent]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ agentId: "live-1", agentName: "Live-Bot" }),
    ]);

    const root = await renderPage();

    const getStat = (label: string) => {
      const span = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === label);
      return span?.parentElement?.querySelector("span:last-child")?.textContent;
    };

    expect(getStat("전체 인원")).toBe("2");
    expect(getStat("업무 중")).toBe("1");
    expect(getStat("오류/차단")).toBe("0");
    expect(getStat("오프라인")).toBe("0");

    act(() => root.unmount());
  });

  it("defaults to 2D Office view and switches to JARVIS Neural Map when button is clicked", async () => {
    const root = await renderPage();

    const floorBtn = container.querySelector("[data-testid='view-mode-floor-btn']") as HTMLButtonElement;
    const neuralBtn = container.querySelector("[data-testid='view-mode-neural-btn']") as HTMLButtonElement;
    expect(floorBtn).not.toBeNull();
    expect(neuralBtn).not.toBeNull();
    expect(floorBtn.getAttribute("aria-pressed")).toBe("true");
    expect(neuralBtn.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      neuralBtn.click();
    });
    await flushReact();

    expect(neuralBtn.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-testid='jarvis-neural-command-interface']")).not.toBeNull();
    expect(container.textContent).toContain("JARVIS Neural Command Map");

    act(() => root.unmount());
  });

  it("default 2D Office view never calls the Neural telemetry endpoint", async () => {
    // A prior test can leave ?view=neural in the URL (view mode is read from
    // window.location at mount) — reset explicitly so this test genuinely
    // exercises the default floor view regardless of execution order.
    const originalHref = window.location.href;
    window.history.replaceState({}, "", "/PAP/ai-office");

    const root = await renderPage();

    expect(container.querySelector("[data-testid='jarvis-neural-command-interface']")).toBeNull();
    expect(mockHeartbeatsApi.neuralRoutes).not.toHaveBeenCalled();

    act(() => root.unmount());
    window.history.replaceState({}, "", originalHref);
  });

  it("switching to JARVIS Neural Map calls neuralRoutes with the existing selectedCompanyId (never a hardcoded id)", async () => {
    const originalHref = window.location.href;
    window.history.replaceState({}, "", "/PAP/ai-office");

    const root = await renderPage();

    const neuralBtn = container.querySelector("[data-testid='view-mode-neural-btn']") as HTMLButtonElement;
    act(() => {
      neuralBtn.click();
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector("[data-testid='jarvis-neural-command-interface']")).not.toBeNull();
    // "company-1" here is the same mocked useCompany().selectedCompanyId value
    // every other assertion in this file already relies on (see the
    // CompanyContext mock above and e.g. the emergencyPause assertion) — not
    // a value introduced by this test.
    expect(mockHeartbeatsApi.neuralRoutes).toHaveBeenCalledWith("company-1");

    act(() => root.unmount());
    window.history.replaceState({}, "", originalHref);
  });

  it("renders JARVIS Neural Map directly when ?view=neural is in URL", async () => {
    const originalHref = window.location.href;
    window.history.replaceState({}, "", "/PAP/ai-office?view=neural");

    const root = await renderPage();

    const neuralBtn = container.querySelector("[data-testid='view-mode-neural-btn']") as HTMLButtonElement;
    expect(neuralBtn).not.toBeNull();
    expect(neuralBtn.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-testid='jarvis-neural-command-interface']")).not.toBeNull();

    act(() => root.unmount());
    window.history.replaceState({}, "", originalHref);
  });
});
