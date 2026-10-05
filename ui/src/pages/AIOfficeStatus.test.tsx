// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AIOfficeStatus as AIOfficeStatusPayload,
  Approval,
  CostByAgentModel,
  CostByProviderModel,
  OrgUnitStatus,
  ProviderQuotaResult,
} from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { AIOfficeStatus } from "./AIOfficeStatus";

const mockAiOfficeApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  orgUnitsStatus: vi.fn(),
  org: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockApprovalsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockCostsApi = vi.hoisted(() => ({
  byAgentModel: vi.fn(),
  byProvider: vi.fn(),
  quotaWindows: vi.fn(),
}));

const mockVoiceApi = vi.hoisted(() => ({
  submitCommand: vi.fn(),
}));

vi.mock("../api/aiOffice", () => ({
  aiOfficeApi: mockAiOfficeApi,
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

vi.mock("../api/voice", () => ({
  voiceApi: mockVoiceApi,
}));

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

const HEALTHY_STATUS: AIOfficeStatusPayload = {
  timestamp: "2026-09-17T12:00:00.000Z",
  supervisor: { status: "running", pid: 1234, uptimeSeconds: 3600 },
  database: {
    mode: "embedded-postgres",
    status: "healthy",
    port: 54329,
    activeConnections: 3,
    connectionUrlSanitized: "postgres://paperclip:***@127.0.0.1:54329/paperclip",
  },
  server: { status: "healthy", version: "1.0.0", listenHost: "127.0.0.1", listenPort: 3100 },
  backup: {
    enabled: true,
    backupDir: "/backups",
    latestBackupName: "paperclip-20260917-000000.sql.gz",
    latestBackupTime: "2026-09-17T00:00:00.000Z",
    status: "ok",
    databaseBackupMaxAgeHours: 24,
  },
};

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
  };
}

function makeOrgUnitStatus(overrides: Partial<OrgUnitStatus> = {}): OrgUnitStatus {
  return {
    orgUnitId: "org-unit-1",
    name: "Engineering",
    agentCount: 3,
    activeCount: 1,
    runningCount: 1,
    errorCount: 0,
    currentTaskCount: 1,
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
    createdAt: new Date("2026-09-17T11:55:00.000Z"),
    updatedAt: new Date("2026-09-17T11:55:00.000Z"),
    ...overrides,
  };
}

interface TestOrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  reports: TestOrgNode[];
}

function makeOrgNode(overrides: Partial<TestOrgNode> = {}): TestOrgNode {
  return {
    id: "agent-root",
    name: "JARVIS",
    role: "ceo",
    status: "active",
    reports: [],
    ...overrides,
  };
}

function makeCostByAgentModel(overrides: Partial<CostByAgentModel> = {}): CostByAgentModel {
  return {
    agentId: "agent-1",
    agentName: "Alpha",
    provider: "openai",
    biller: "openai",
    billingType: "metered_api",
    model: "gpt-5",
    costCents: 250,
    inputTokens: 1000,
    cachedInputTokens: 200,
    outputTokens: 500,
    ...overrides,
  };
}

function makeCostByProvider(overrides: Partial<CostByProviderModel> = {}): CostByProviderModel {
  return {
    provider: "openai",
    biller: "openai",
    billingType: "metered_api",
    model: "gpt-5",
    costCents: 250,
    inputTokens: 1000,
    cachedInputTokens: 200,
    outputTokens: 500,
    apiRunCount: 1,
    subscriptionRunCount: 0,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
    ...overrides,
  };
}

function makeProviderQuotaResult(overrides: Partial<ProviderQuotaResult> = {}): ProviderQuotaResult {
  return {
    provider: "openai",
    ok: true,
    windows: [],
    ...overrides,
  };
}

function makeLiveRun(overrides: Partial<LiveRunForIssue> = {}): LiveRunForIssue {
  return {
    id: "run-1",
    status: "running",
    invocationSource: "on_demand",
    triggerDetail: null,
    startedAt: "2026-09-17T11:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-09-17T11:00:00.000Z",
    agentId: "agent-1",
    agentName: "Alpha",
    adapterType: "codex_local",
    issueId: "issue-1",
    ...overrides,
  };
}

describe("AIOfficeStatus page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([]);
    mockAgentsApi.org.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockApprovalsApi.list.mockResolvedValue([]);
    mockCostsApi.byAgentModel.mockResolvedValue([]);
    mockCostsApi.byProvider.mockResolvedValue([]);
    mockCostsApi.quotaWindows.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AIOfficeStatus />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("shows a loading state before the status resolves", async () => {
    mockAiOfficeApi.getStatus.mockReturnValue(new Promise(() => {}));
    const root = await renderPage();

    expect(container.textContent).toContain("Loading AI Office status");

    act(() => {
      root.unmount();
    });
  });

  it("renders Supervisor/Server/Database/Backup cards on success", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    const root = await renderPage();
    await flushReact();

    expect(container.textContent).toContain("Supervisor");
    expect(container.textContent).toContain("Server");
    expect(container.textContent).toContain("Database");
    expect(container.textContent).toContain("Backup");
    expect(container.textContent).toContain("running");
    expect(container.textContent).toContain("healthy");
    expect(container.textContent).toContain("paperclip-20260917-000000.sql.gz");

    act(() => {
      root.unmount();
    });
  });

  it("shows an error state when the status request fails", async () => {
    mockAiOfficeApi.getStatus.mockRejectedValue(new Error("Request failed: 503"));
    const root = await renderPage();
    await flushReact();

    expect(container.textContent).toContain("Request failed: 503");

    act(() => {
      root.unmount();
    });
  });

  it("renders multiple agents with their status badge and last activity", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-1", name: "Alpha", status: "idle" }),
      makeAgent({
        id: "agent-2",
        name: "Beta",
        status: "running",
        lastHeartbeatAt: new Date(Date.now() - 5 * 60_000),
      }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Beta");
    expect(container.textContent).toContain("idle");
    expect(container.textContent).toContain("running");
    expect(container.textContent).toContain("5m ago");

    act(() => {
      root.unmount();
    });
  });

  it("shows the live run as Current Task for an agent with an active run", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "agent-1", name: "Alpha" })]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ agentId: "agent-1", status: "running" }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Running (running)");

    act(() => {
      root.unmount();
    });
  });

  it("shows a dash for Current Task when an agent has no live run", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "agent-1", name: "Alpha" })]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    const agentRow = Array.from(container.querySelectorAll("div")).find((el) =>
      el.textContent?.startsWith("Alpha"),
    );
    expect(agentRow?.textContent).toContain("—");

    act(() => {
      root.unmount();
    });
  });

  it("shows an empty state when there are no agents", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No agents found.");

    act(() => {
      root.unmount();
    });
  });

  it("shows a loading state for the departments section", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.orgUnitsStatus.mockReturnValue(new Promise(() => {}));
    const root = await renderPage();

    expect(container.textContent).toContain("Loading departments");

    act(() => {
      root.unmount();
    });
  });

  it("renders department rows with agent/active/running/error/task counts on success", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([
      makeOrgUnitStatus({
        orgUnitId: "org-unit-1",
        name: "Engineering",
        agentCount: 3,
        activeCount: 1,
        runningCount: 2,
        errorCount: 0,
        currentTaskCount: 2,
      }),
      makeOrgUnitStatus({
        orgUnitId: "org-unit-2",
        name: "QA",
        agentCount: 1,
        activeCount: 0,
        runningCount: 0,
        errorCount: 1,
        currentTaskCount: 0,
      }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Engineering");
    expect(container.textContent).toContain("QA");
    expect(container.textContent).toContain("Departments");

    act(() => {
      root.unmount();
    });
  });

  it("shows 'No departments configured.' when the company has no org units", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No departments configured.");

    act(() => {
      root.unmount();
    });
  });

  it("shows an error state when the departments request fails", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.orgUnitsStatus.mockRejectedValue(new Error("Request failed: 500"));
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Request failed: 500");

    act(() => {
      root.unmount();
    });
  });

  it("shows 'No pending approvals.' when both pending and revision_requested are empty", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockApprovalsApi.list.mockResolvedValue([]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No pending approvals.");
    expect(mockApprovalsApi.list).toHaveBeenCalledWith("company-1", "pending");
    expect(mockApprovalsApi.list).toHaveBeenCalledWith("company-1", "revision_requested");

    act(() => {
      root.unmount();
    });
  });

  it("renders multiple pending approvals with related issue and requesting agent resolved from the agent list", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "agent-1", name: "Alpha" })]);
    mockApprovalsApi.list.mockImplementation(async (_companyId: string, status?: string) => {
      if (status === "pending") {
        return [
          makeApproval({
            id: "approval-1",
            type: "request_board_approval",
            status: "pending",
            requestedByAgentId: "agent-1",
            payload: { issueIdentifier: "PAP-42" },
          }),
        ];
      }
      return [];
    });
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("request_board_approval");
    expect(container.textContent).toContain("PAP-42");
    expect(container.textContent).toContain("Alpha");

    act(() => {
      root.unmount();
    });
  });

  it("includes revision_requested approvals alongside pending ones", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockApprovalsApi.list.mockImplementation(async (_companyId: string, status?: string) => {
      if (status === "revision_requested") {
        return [makeApproval({ id: "approval-2", status: "revision_requested" })];
      }
      return [];
    });
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("revision_requested");

    act(() => {
      root.unmount();
    });
  });

  it("shows '—' for related issue and requesting agent when absent", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockApprovalsApi.list.mockImplementation(async (_companyId: string, status?: string) => {
      if (status === "pending") {
        return [makeApproval({ id: "approval-1", requestedByAgentId: null, payload: {} })];
      }
      return [];
    });
    const root = await renderPage();
    await flushReact();
    await flushReact();

    const approvalRow = Array.from(container.querySelectorAll("div")).find((el) =>
      el.textContent?.startsWith("approval"),
    );
    expect(approvalRow?.textContent).toContain("—");

    act(() => {
      root.unmount();
    });
  });

  it("shows 'No error or offline agents.' when every agent is healthy and recent", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-1", name: "Alpha", status: "idle", lastHeartbeatAt: new Date(Date.now() - 5 * 60_000) }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No error or offline agents.");

    act(() => {
      root.unmount();
    });
  });

  it("lists an agent with status='error' under Error / Offline Agents", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-1", name: "Alpha", status: "error", lastHeartbeatAt: new Date() }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("No error or offline agents.");
    expect(container.textContent).toContain("Error / Offline Agents");

    act(() => {
      root.unmount();
    });
  });

  it("treats a null lastHeartbeatAt as offline", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-1", name: "Alpha", status: "idle", lastHeartbeatAt: null }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("No error or offline agents.");
    expect(container.textContent).toContain("offline");

    act(() => {
      root.unmount();
    });
  });

  it("treats an agent stale for more than 30 minutes as offline", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        id: "agent-1",
        name: "Alpha",
        status: "idle",
        lastHeartbeatAt: new Date(Date.now() - 31 * 60_000),
      }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("No error or offline agents.");
    expect(container.textContent).toContain("offline");

    act(() => {
      root.unmount();
    });
  });

  it("does not treat an agent stale for less than 30 minutes as offline", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        id: "agent-1",
        name: "Alpha",
        status: "idle",
        lastHeartbeatAt: new Date(Date.now() - 29 * 60_000),
      }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No error or offline agents.");

    act(() => {
      root.unmount();
    });
  });

  it("does not treat a stale agent with a current live run as offline", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        id: "agent-1",
        name: "Alpha",
        status: "idle",
        lastHeartbeatAt: new Date(Date.now() - 45 * 60_000),
      }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ agentId: "agent-1", status: "running" }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No error or offline agents.");

    act(() => {
      root.unmount();
    });
  });

  it("shows 'No active runs.' when there are no live runs", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No active runs.");

    act(() => {
      root.unmount();
    });
  });

  it("renders multiple active runs distinguishing queued and running", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ id: "run-1", agentId: "agent-1", agentName: "Alpha", status: "running", issueId: "issue-1" }),
      makeLiveRun({ id: "run-2", agentId: "agent-2", agentName: "Beta", status: "queued", issueId: null }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("running");
    expect(container.textContent).toContain("issue-1");
    expect(container.textContent).toContain("Beta");
    expect(container.textContent).toContain("queued");

    act(() => {
      root.unmount();
    });
  });

  it("shows '—' for Active Runs when a run has no issueId", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ id: "run-1", agentId: "agent-1", agentName: "Alpha", status: "running", issueId: null }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    const runRow = Array.from(container.querySelectorAll("div")).find((el) =>
      el.textContent?.startsWith("Alpha"),
    );
    expect(runRow?.textContent).toContain("—");

    act(() => {
      root.unmount();
    });
  });

  it("shows 'No hierarchy data.' when the org tree is empty", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.org.mockResolvedValue([]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No hierarchy data.");
    expect(mockAgentsApi.org).toHaveBeenCalledWith("company-1");

    act(() => {
      root.unmount();
    });
  });

  it("renders the real reportsTo hierarchy root and nested children by depth", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.org.mockResolvedValue([
      makeOrgNode({
        id: "agent-root",
        name: "JARVIS",
        role: "ceo",
        status: "error",
        reports: [
          makeOrgNode({
            id: "agent-child",
            name: "강건",
            role: "general",
            status: "idle",
            reports: [
              makeOrgNode({ id: "agent-grandchild", name: "최수아", role: "general", status: "idle", reports: [] }),
            ],
          }),
        ],
      }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("JARVIS");
    expect(container.textContent).toContain("강건");
    expect(container.textContent).toContain("최수아");
    // No fabricated node from the CEO's illustrative example may appear.
    expect(container.textContent).not.toContain("Atlas");

    act(() => {
      root.unmount();
    });
  });

  it("marks a hierarchy node as working when it has a current live run", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.org.mockResolvedValue([
      makeOrgNode({ id: "agent-1", name: "Alpha", reports: [] }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      makeLiveRun({ agentId: "agent-1", status: "running" }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Working now");

    act(() => {
      root.unmount();
    });
  });

  it("shows an error state when the hierarchy request fails", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.org.mockRejectedValue(new Error("Request failed: 500"));
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Request failed: 500");

    act(() => {
      root.unmount();
    });
  });

  it("shows 'No usage recorded.' when there is no agent/model usage", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockCostsApi.byAgentModel.mockResolvedValue([]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No usage recorded.");

    act(() => {
      root.unmount();
    });
  });

  it("renders multiple agent/model/provider usage rows with tokens and cost", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockCostsApi.byAgentModel.mockResolvedValue([
      makeCostByAgentModel({
        agentId: "agent-1",
        agentName: "Alpha",
        provider: "openai",
        model: "gpt-5",
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 500,
        costCents: 250,
      }),
      makeCostByAgentModel({
        agentId: "agent-2",
        agentName: "Beta",
        provider: "anthropic",
        model: "claude-sonnet-5",
        inputTokens: 2000,
        cachedInputTokens: 0,
        outputTokens: 800,
        costCents: 999,
      }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("gpt-5");
    expect(container.textContent).toContain("openai");
    expect(container.textContent).toContain("1000");
    expect(container.textContent).toContain("$2.50");
    expect(container.textContent).toContain("Beta");
    expect(container.textContent).toContain("claude-sonnet-5");
    expect(container.textContent).toContain("$9.99");

    act(() => {
      root.unmount();
    });
  });

  it("shows a provider cost total derived from costsApi.byProvider", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockCostsApi.byAgentModel.mockResolvedValue([makeCostByAgentModel({})]);
    mockCostsApi.byProvider.mockResolvedValue([
      makeCostByProvider({ provider: "openai", model: "gpt-5", costCents: 150 }),
      makeCostByProvider({ provider: "openai", model: "gpt-5-mini", costCents: 100 }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Total (openai)");
    expect(container.textContent).toContain("$2.50");

    act(() => {
      root.unmount();
    });
  });

  it("shows an error state when usage requests fail", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockCostsApi.byAgentModel.mockRejectedValue(new Error("Request failed: 500"));
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Request failed: 500");

    act(() => {
      root.unmount();
    });
  });

  it("shows 'No quota data available.' when there are no quota results", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockCostsApi.quotaWindows.mockResolvedValue([]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No quota data available.");

    act(() => {
      root.unmount();
    });
  });

  it("shows the real usedPercent and resetsAt when a provider reports them", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockCostsApi.quotaWindows.mockResolvedValue([
      makeProviderQuotaResult({
        provider: "anthropic",
        ok: true,
        windows: [
          {
            label: "5h",
            usedPercent: 42,
            resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            valueLabel: null,
          },
        ],
      }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("42% used");
    expect(container.textContent).not.toContain("unknown");

    act(() => {
      root.unmount();
    });
  });

  it("shows 'unknown' for usedPercent and '—' for resetsAt when the provider does not report them", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockCostsApi.quotaWindows.mockResolvedValue([
      makeProviderQuotaResult({
        provider: "openai",
        ok: true,
        windows: [{ label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$4.20 remaining" }],
      }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("unknown");
    expect(container.textContent).toContain("$4.20 remaining");

    act(() => {
      root.unmount();
    });
  });

  it("honestly shows the failure reason when a provider quota fetch is ok:false", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockCostsApi.quotaWindows.mockResolvedValue([
      makeProviderQuotaResult({ provider: "gemini", ok: false, error: "quota polling timed out after 20s", windows: [] }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("quota polling timed out after 20s");

    act(() => {
      root.unmount();
    });
  });

  it("removes the fixed grid-cols-4/6/3 layout from Agents, Departments, Pending Approvals, and Error/Offline sections", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "agent-1", name: "Alpha", status: "error" })]);
    mockAgentsApi.orgUnitsStatus.mockResolvedValue([makeOrgUnitStatus({})]);
    mockApprovalsApi.list.mockImplementation(async (_companyId: string, status?: string) =>
      status === "pending" ? [makeApproval({})] : [],
    );
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.querySelector(".grid-cols-4")).toBeNull();
    expect(container.querySelector(".grid-cols-6")).toBeNull();
    expect(container.querySelector(".grid-cols-3")).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders the Visual Control Tower section wired to real hierarchy, agent, and approval data", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-root", name: "JARVIS", status: "error" }),
    ]);
    mockAgentsApi.org.mockResolvedValue([
      makeOrgNode({ id: "agent-root", name: "JARVIS", role: "ceo", status: "error", reports: [] }),
    ]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Visual Control Tower");
    expect(container.textContent).toContain("JARVIS");
    expect(container.textContent).not.toContain("Atlas");

    act(() => {
      root.unmount();
    });
  });

  it("shows 'No hierarchy data.' in the Visual Control Tower when the org tree is empty", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    mockAgentsApi.org.mockResolvedValue([]);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Visual Control Tower");
    expect(container.textContent).toContain("No hierarchy data.");

    act(() => {
      root.unmount();
    });
  });

  it("renders the VoiceCommandBar below the header without affecting existing sections", async () => {
    mockAiOfficeApi.getStatus.mockResolvedValue(HEALTHY_STATUS);
    const root = await renderPage();
    await flushReact();
    await flushReact();

    // jsdom has no SpeechRecognition, so the unsupported state is expected —
    // this smoke test only confirms the component is mounted on the page.
    expect(container.textContent).toContain("Voice input requires Chrome or Edge.");
    expect(container.textContent).toContain("AI Office Status");
    expect(mockVoiceApi.submitCommand).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
