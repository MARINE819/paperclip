import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, orgUnits } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  orgUnitStatusForCompany: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  buildRunOutputSilence: vi.fn(),
  decorateActiveRunStatus: vi.fn(),
  getRunIssueSummary: vi.fn(),
  getActiveRunIssueSummaryForAgent: vi.fn(),
  getRunLogAccess: vi.fn(),
  readLog: vi.fn(),
  wakeup: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const mockRunSecretRedactionRegistry = vi.hoisted(() => ({
  redactForRun: vi.fn(async (_companyId: string, _runId: string, value: unknown) => value),
}));

const routeAgentId = "11111111-1111-4111-8111-111111111111";

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/run-secret-redaction.js", () => ({
    createRunSecretRedactionRegistry: () => mockRunSecretRedactionRegistry,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_explicit_grant",
        explanation: "Allowed by test grant.",
      })),
      hasPermission: vi.fn(async () => true),
    }),
    approvalService: () => ({}),
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: vi.fn(),
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

async function createApp(db: Record<string, unknown> = {}) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

function createLiveRunsDbStub(rows: Array<Record<string, unknown>>) {
  const limit = vi.fn(async (value: number) => rows.slice(0, value));
  const orderedQuery = {
    limit,
    then: (resolve: (value: Array<Record<string, unknown>>) => unknown) => Promise.resolve(rows).then(resolve),
  };
  const query = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnValue(orderedQuery),
  };

  return {
    db: {
      select: vi.fn().mockReturnValue(query),
    },
    limit,
  };
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe("agent live run routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionRunId: "run-1",
      assigneeAgentId: "agent-1",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Builder",
      adapterType: "codex_local",
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({});
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockHeartbeatService.buildRunOutputSilence.mockResolvedValue(null);
    mockHeartbeatService.decorateActiveRunStatus.mockImplementation((run) => ({
      ...run,
      currentStatusMessage: null,
      currentStatusUpdatedAt: null,
    }));
    mockHeartbeatService.getRunIssueSummary.mockResolvedValue({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      contextCommentId: "comment-1",
      contextWakeCommentId: "comment-1",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:29:59.000Z"),
      agentId: "agent-1",
      issueId: "issue-1",
    });
    mockHeartbeatService.getActiveRunIssueSummaryForAgent.mockResolvedValue(null);
    mockHeartbeatService.buildRunOutputSilence.mockResolvedValue(null);
    mockHeartbeatService.getRunLogAccess.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      logStore: "local_file",
      logRef: "logs/run-1.ndjson",
    });
    mockHeartbeatService.readLog.mockResolvedValue({
      runId: "run-1",
      store: "local_file",
      logRef: "logs/run-1.ndjson",
      content: "chunk",
      nextOffset: 5,
    });
    mockHeartbeatService.wakeup.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "queued",
      invocationSource: "on_demand",
      triggerDetail: "manual",
    });
  });

  it("returns a compact active run payload for issue polling", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/issues/pc1a2-1295/active-run"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PC1A2-1295");
    expect(mockHeartbeatService.getRunIssueSummary).toHaveBeenCalledWith("run-1");
    expect(res.body).toMatchObject({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      contextCommentId: "comment-1",
      contextWakeCommentId: "comment-1",
      startedAt: "2026-04-10T09:30:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-10T09:29:59.000Z",
      agentId: "agent-1",
      issueId: "issue-1",
      agentName: "Builder",
      adapterType: "codex_local",
      outputSilence: null,
      currentStatusMessage: null,
      currentStatusUpdatedAt: null,
    });
    expect(res.body).not.toHaveProperty("resultJson");
    expect(res.body).not.toHaveProperty("contextSnapshot");
    expect(res.body).not.toHaveProperty("logRef");
  }, 10_000);

  it("ignores a stale execution run from another issue and falls back to the assignee's matching run", async () => {
    mockHeartbeatService.getRunIssueSummary.mockResolvedValue({
      id: "run-foreign",
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "callback",
      startedAt: new Date("2026-04-10T10:00:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:59:00.000Z"),
      agentId: "agent-1",
      issueId: "issue-2",
    });
    mockHeartbeatService.getActiveRunIssueSummaryForAgent.mockResolvedValue({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:29:59.000Z"),
      agentId: "agent-1",
      issueId: "issue-1",
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/issues/PC1A2-1295/active-run"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.getRunIssueSummary).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.getActiveRunIssueSummaryForAgent).toHaveBeenCalledWith("agent-1");
    expect(res.body).toMatchObject({
      id: "run-1",
      issueId: "issue-1",
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
    });
  });

  it("includes ephemeral current status fields on active run polling", async () => {
    mockHeartbeatService.decorateActiveRunStatus.mockImplementation((run) => ({
      ...run,
      currentStatusMessage: "Syncing workspace to environment",
      currentStatusUpdatedAt: new Date("2026-04-10T09:30:05.000Z"),
      currentToolName: "bash",
      lastAssistantSnippet: "Inspecting files",
      lastEventAt: new Date("2026-04-10T09:30:06.000Z"),
    }));

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/issues/PC1A2-1295/active-run"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.decorateActiveRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", issueId: "issue-1" }),
      { companyId: "company-1", issueId: "issue-1" },
    );
    expect(res.body).toMatchObject({
      currentStatusMessage: "Syncing workspace to environment",
      currentStatusUpdatedAt: "2026-04-10T09:30:05.000Z",
      currentToolName: "bash",
      lastAssistantSnippet: "Inspecting files",
      lastEventAt: "2026-04-10T09:30:06.000Z",
    });
  });

  it("uses narrow run log metadata lookups for log polling", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log?offset=12&limitBytes=64"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.getRunLogAccess).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.readLog).toHaveBeenCalledWith({
      id: "run-1",
      companyId: "company-1",
      logStore: "local_file",
      logRef: "logs/run-1.ndjson",
    }, {
      offset: 12,
      limitBytes: 64,
    });
    expect(res.body).toEqual({
      runId: "run-1",
      store: "local_file",
      logRef: "logs/run-1.ndjson",
      content: "chunk",
      nextOffset: 5,
    });
  });

  it("caps company live run polling by default", async () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      id: `run-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(`2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));
    const { db, limit } = createLiveRunsDbStub(rows);

    const res = await requestApp(
      await createApp(db),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/live-runs"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(limit).toHaveBeenCalledWith(50);
    expect(res.body).toHaveLength(50);
    expect(mockHeartbeatService.buildRunOutputSilence).toHaveBeenCalledTimes(50);
  });

  it("treats explicit zero or invalid live run limit as the capped default", async () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      id: `run-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(`2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));
    const { db, limit } = createLiveRunsDbStub(rows);

    const res = await requestApp(
      await createApp(db),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/live-runs?limit=0&minCount=0"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(limit).toHaveBeenCalledWith(50);
    expect(res.body).toHaveLength(50);
  });

  it("does not pad with recent runs when no minCount is requested", async () => {
    const liveRows = Array.from({ length: 8 }, (_, index) => ({
      id: `run-live-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(`2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));

    const selectCalls: Array<ReturnType<typeof vi.fn>> = [];
    const db = {
      select: vi.fn().mockImplementation(() => {
        const limitFn = vi.fn(async (value: number) => liveRows.slice(0, value));
        const orderedQuery = {
          limit: limitFn,
          then: (resolve: (value: typeof liveRows) => unknown) =>
            Promise.resolve(liveRows).then(resolve),
        };
        const query = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnValue(orderedQuery),
        };
        selectCalls.push(limitFn);
        return query;
      }),
    };

    const res = await requestApp(
      await createApp(db),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/live-runs"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(8);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("pads with recent runs when minCount is explicitly requested", async () => {
    const liveRows = Array.from({ length: 2 }, (_, index) => ({
      id: `run-live-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(`2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));
    const recentRows = Array.from({ length: 4 }, (_, index) => ({
      id: `run-recent-${index}`,
      companyId: "company-1",
      status: "succeeded",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-09T09:30:00.000Z"),
      finishedAt: new Date("2026-04-09T09:35:00.000Z"),
      createdAt: new Date(`2026-04-09T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));

    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount += 1;
        const rows = selectCallCount === 1 ? liveRows : recentRows;
        const limitFn = vi.fn(async (value: number) => rows.slice(0, value));
        const orderedQuery = {
          limit: limitFn,
          then: (resolve: (value: typeof rows) => unknown) =>
            Promise.resolve(rows).then(resolve),
        };
        return {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnValue(orderedQuery),
        };
      }),
    };

    const res = await requestApp(
      await createApp(db),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/live-runs?minCount=4"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("returns the org unit status list from the service unchanged", async () => {
    mockAgentService.orgUnitStatusForCompany.mockResolvedValue([
      {
        orgUnitId: "org-unit-1",
        name: "Engineering",
        agentCount: 3,
        activeCount: 1,
        runningCount: 1,
        errorCount: 0,
        currentTaskCount: 1,
      },
    ]);

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/org-units/status"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.orgUnitStatusForCompany).toHaveBeenCalledWith("company-1");
    expect(res.body).toEqual([
      {
        orgUnitId: "org-unit-1",
        name: "Engineering",
        agentCount: 3,
        activeCount: 1,
        runningCount: 1,
        errorCount: 0,
        currentTaskCount: 1,
      },
    ]);
  });

  it("returns an empty array when the company has no org units", async () => {
    mockAgentService.orgUnitStatusForCompany.mockResolvedValue([]);

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/org-units/status"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("passes scoped wake fields through the legacy heartbeat invoke route", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .post(`/api/agents/${routeAgentId}/heartbeat/invoke?companyId=company-1`)
        .send({
          reason: "issue_assigned",
          payload: {
            issueId: "issue-1",
            taskId: "issue-1",
            taskKey: "issue-1",
          },
          forceFreshSession: true,
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    // The legacy /heartbeat/invoke endpoint forwards only the wake fields the
    // caller actually supplied so empty-body callers (e.g. e2e suites) match
    // the original fixed-arg `heartbeat.invoke()` shape exactly. When the
    // caller supplies reason / payload / forceFreshSession those are
    // forwarded; idempotencyKey is omitted unless explicitly set.
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(routeAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_assigned",
      payload: {
        issueId: "issue-1",
        taskId: "issue-1",
        taskKey: "issue-1",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: {
        triggeredBy: "board",
        actorId: "local-board",
        forceFreshSession: true,
      },
    });
  });

  it("calls heartbeat.wakeup with the legacy minimal shape when the body is empty", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .post(`/api/agents/${routeAgentId}/heartbeat/invoke?companyId=company-1`)
        .send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(routeAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: {
        triggeredBy: "board",
        actorId: "local-board",
      },
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agentService.orgUnitStatusForCompany (Stage 9 Phase 9.3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeEach(async () => {
    // The mocked-route describe block above leaves `../services/agents.js`
    // doMock'd with no cleanup of its own. Vite resolves that specifier to
    // the same module record as this block's `../services/agents.ts` import,
    // so without explicitly unmocking here, this block would silently import
    // the stale mock (always returning whatever it last resolved) instead of
    // the real service — proven by real-DB seeded rows returning [] until
    // this fix was added.
    vi.doUnmock("../services/agents.js");
    vi.resetModules();
    tempDb = await startEmbeddedPostgresTestDatabase("agent-org-unit-status-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await tempDb?.cleanup();
    tempDb = null;
  });

  async function seedCompany(label: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${label} Co`,
      issuePrefix: `OU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedOrgUnit(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(orgUnits).values({ id, companyId, name });
    return id;
  }

  async function seedAgent(companyId: string, orgUnitId: string | null, status: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `Agent ${id.slice(0, 8)}`,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      orgUnitId,
    });
    return id;
  }

  async function seedLiveRun(companyId: string, agentId: string, issueId: string | null) {
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: issueId ? { issueId } : {},
    });
  }

  it("returns 'No departments configured.'-equivalent empty array when the company has no org units", async () => {
    const { agentService } = await import("../services/agents.ts");
    const companyId = await seedCompany("Empty");

    const result = await agentService(db).orgUnitStatusForCompany(companyId);

    expect(result).toEqual([]);
  });

  it("reports zero counts for a department with no agents", async () => {
    const { agentService } = await import("../services/agents.ts");
    const companyId = await seedCompany("NoAgents");
    const orgUnitId = await seedOrgUnit(companyId, "Empty Dept");

    const result = await agentService(db).orgUnitStatusForCompany(companyId);

    expect(result).toEqual([
      { orgUnitId, name: "Empty Dept", agentCount: 0, activeCount: 0, runningCount: 0, errorCount: 0, currentTaskCount: 0 },
    ]);
  });

  it("counts mixed agent statuses (active/idle/error) correctly with no double counting", async () => {
    const { agentService } = await import("../services/agents.ts");
    const companyId = await seedCompany("Mixed");
    const orgUnitId = await seedOrgUnit(companyId, "Mixed Dept");
    await seedAgent(companyId, orgUnitId, "active");
    await seedAgent(companyId, orgUnitId, "idle");
    await seedAgent(companyId, orgUnitId, "error");

    const [status] = await agentService(db).orgUnitStatusForCompany(companyId);

    expect(status.agentCount).toBe(3);
    expect(status.activeCount).toBe(1);
    expect(status.errorCount).toBe(1);
    expect(status.runningCount).toBe(0);
  });

  it("counts runningCount from live heartbeat runs (queued/running), not from agent.status", async () => {
    const { agentService } = await import("../services/agents.ts");
    const companyId = await seedCompany("Running");
    const orgUnitId = await seedOrgUnit(companyId, "Running Dept");
    const idleAgentWithLiveRun = await seedAgent(companyId, orgUnitId, "idle");
    await seedAgent(companyId, orgUnitId, "idle");
    await seedLiveRun(companyId, idleAgentWithLiveRun, "issue-1");

    const [status] = await agentService(db).orgUnitStatusForCompany(companyId);

    expect(status.runningCount).toBe(1);
  });

  it("counts currentTaskCount as distinct issueId across the department, falling back to runId when issueId is absent", async () => {
    const { agentService } = await import("../services/agents.ts");
    const companyId = await seedCompany("Tasks");
    const orgUnitId = await seedOrgUnit(companyId, "Tasks Dept");
    const agentA = await seedAgent(companyId, orgUnitId, "idle");
    const agentB = await seedAgent(companyId, orgUnitId, "idle");
    // Two runs on the same issue must count as one task, not two.
    await seedLiveRun(companyId, agentA, "issue-shared");
    await seedLiveRun(companyId, agentB, "issue-shared");
    // A run with no issueId (ad-hoc prompt) must still count as its own task.
    await seedLiveRun(companyId, agentB, null);

    const [status] = await agentService(db).orgUnitStatusForCompany(companyId);

    expect(status.currentTaskCount).toBe(2);
    expect(status.runningCount).toBe(2);
  });

  it("never leaks another company's org units or agents into the result", async () => {
    const { agentService } = await import("../services/agents.ts");
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const orgUnitA = await seedOrgUnit(companyA, "Dept A");
    await seedOrgUnit(companyB, "Dept B");
    await seedAgent(companyA, orgUnitA, "active");
    await seedAgent(companyB, null, "active");

    const resultA = await agentService(db).orgUnitStatusForCompany(companyA);

    expect(resultA).toHaveLength(1);
    expect(resultA[0].name).toBe("Dept A");
    expect(resultA[0].agentCount).toBe(1);
  });
});
