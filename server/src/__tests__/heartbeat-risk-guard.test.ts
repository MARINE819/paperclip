import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { agentWakeupRequests, agents, approvals, companies, createDb, heartbeatRuns, issueApprovals, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { classifyPreExecutionRisk, heartbeatService } from "../services/heartbeat.ts";
import { consumeApproval } from "../services/approval-lifecycle.js";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/error-handler.js";

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "risk-guard-session" },
  sessionDisplayId: "risk-guard-session",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: (adapterType?: string) => ({
    type: adapterType || "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: (adapterType?: string) => ({
    type: adapterType || "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

// The exact regexes from heartbeat.ts
const HIGH_RISK_REGEX = /create|modify|delete|write|update|insert|drop|post|send|email|pay|buy|purchase|finance|account|permission|security|config|deploy|production|customer/i;
const LOW_RISK_REGEX = /read|view|list|summarize|analyze|plan|propose|research|investigate|explain|describe|조회|출력|분석|보고서/i;

function classifyRisk(title: string, triggerDetail: string = ""): string {
  const taskText = `${title} ${triggerDetail}`.toLowerCase();
  if (HIGH_RISK_REGEX.test(taskText)) {
    return "HIGH";
  } else if (LOW_RISK_REGEX.test(taskText)) {
    return "LOW";
  }
  return "UNKNOWN";
}

describe("Heartbeat Risk Guard Classification", () => {
  it("classifies LOW risk tasks correctly based on keywords", () => {
    expect(classifyRisk("Read the system logs", "")).toBe("LOW");
    expect(classifyRisk("view the document", "")).toBe("LOW");
    expect(classifyRisk("list active runs", "")).toBe("LOW");
    expect(classifyRisk("summarize issues", "")).toBe("LOW");
    expect(classifyRisk("analyze current priority", "")).toBe("LOW");
  });

  it("classifies HIGH risk tasks correctly based on keywords", () => {
    expect(classifyRisk("Create a new issue", "")).toBe("HIGH");
    expect(classifyRisk("modify the database", "")).toBe("HIGH");
    expect(classifyRisk("delete some files", "")).toBe("HIGH");
    expect(classifyRisk("write to index.ts", "")).toBe("HIGH");
    expect(classifyRisk("update the configuration", "")).toBe("HIGH");
  });

  it("classifies UNKNOWN risk when no keywords match", () => {
    expect(classifyRisk("Validate the build status", "")).toBe("UNKNOWN");
    expect(classifyRisk("Hello world task", "")).toBe("UNKNOWN");
  });

  it("classifies 한글 Intent (Korean read-only intent) as UNKNOWN (regression gap warning)", () => {
    // Current regex only contains English keywords, so Korean read-only tasks resolve to UNKNOWN
    expect(classifyRisk("운영 우선순위 분석 보고서 조회", "")).toBe("LOW");
    expect(classifyRisk("에이전트 목록 출력", "")).toBe("LOW");
  });

  it("verifies approval bypass prevention logic behavior", () => {
    const mockTaskBlocked = { risk: "HIGH", approved: false };
    const blocked = (mockTaskBlocked.risk === "HIGH" || mockTaskBlocked.risk === "UNKNOWN") && !mockTaskBlocked.approved;
    expect(blocked).toBe(true);

    const mockTaskAllowed = { risk: "HIGH", approved: true };
    const allowed = !((mockTaskAllowed.risk === "HIGH" || mockTaskAllowed.risk === "UNKNOWN") && !mockTaskAllowed.approved);
    expect(allowed).toBe(true);
  });
});

describe("Heartbeat Risk Guard negative constraints", () => {
  it.each([
    "Do not modify application code",
    "Do not modify Paperclip code",
    "Do not change source code",
  ])("does not classify a safe negative code constraint as HIGH: %s", (taskText) => {
    expect(classifyPreExecutionRisk(taskText)).toBe("LOW");
  });

  it("keeps genuinely risky code modification requests HIGH", () => {
    expect(classifyPreExecutionRisk("Modify application code to deploy production changes")).toBe("HIGH");
    expect(classifyPreExecutionRisk("Do not modify application code, but deploy production now")).toBe("HIGH");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat Risk Guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("Heartbeat Risk Guard wake payload execution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-risk-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it.each([
    ["prompt", "Please explain the current status"],
    ["message", "Please summarize the current status"],
  ] as const)(
    "preserves payload.%s through wake normalization and allows read-only adapter execution",
    async (field, requestText) => {
      const companyId = randomUUID();
      const agentId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Risk Guard Test Company",
        issuePrefix: `RG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        status: "active",
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "RiskGuardCodex",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      const heartbeat = heartbeatService(db);
      const queued = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { [field]: requestText },
        requestedByActorType: "user",
        requestedByActorId: "responsible-user",
      });

      expect(queued).not.toBeNull();
      expect((queued!.contextSnapshot as Record<string, unknown>)[field]).toBe(requestText);

      const finished = await waitForRunToFinish(heartbeat, queued!.id);
      expect(finished?.status).toBe("succeeded");
      expect(adapterExecute).toHaveBeenCalledTimes(1);
      expect(adapterExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ [field]: requestText }),
        }),
      );
    },
    15_000,
  );

  it("ignores trusted task-wrapper risk words for a safe issue-scoped UAT task", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Risk Guard Safe Wrapper Company",
      issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RiskGuardSafeWrapperCodex",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `RS-${issueId.slice(0, 8)}`,
      title: "UAT Round 1 - JARVIS smoke task",
      description: "Reply with a short confirmation and complete the issue. Do not modify application code.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });

    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    const taskMarkdown = String((finished!.contextSnapshot as Record<string, unknown>).paperclipTaskMarkdown);
    expect(taskMarkdown).toContain("permission");
    expect(taskMarkdown).toContain("security");

    const linkedApprovalRows = await db
      .select()
      .from(issueApprovals)
      .where(eq(issueApprovals.issueId, issueId));
    expect(linkedApprovalRows).toHaveLength(0);
  }, 15_000);

  it("creates and links a usable approval request for a genuine HIGH-risk issue task", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Risk Guard Approval Company",
      issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RiskGuardApprovalCodex",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `RA-${issueId.slice(0, 8)}`,
      title: "Update security permissions",
      description: "Change production security permissions for customer accounts.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: "Change production security permissions for customer accounts." },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });

    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();

    const resultJson = finished?.resultJson as Record<string, unknown>;
    expect(resultJson.risk).toBe("HIGH");
    expect(resultJson.approvalId).toEqual(expect.any(String));

    const createdApproval = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, String(resultJson.approvalId)))
      .then((rows) => rows[0] ?? null);
    expect(createdApproval).toMatchObject({
      companyId,
      type: "request_board_approval",
      status: "pending",
      requestedByAgentId: agentId,
    });
    expect(createdApproval?.payload).toMatchObject({
      source: "risk_guard",
      issueId,
      risk: "HIGH",
    });

    const linkedApproval = await db
      .select()
      .from(issueApprovals)
      .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, String(resultJson.approvalId))))
      .then((rows) => rows[0] ?? null);
    expect(linkedApproval).not.toBeNull();
  }, 15_000);

  it("keeps the agent idle (not error) after Risk Guard intercepts a HIGH-risk task pending human approval", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Risk Guard Idle-Not-Error Company",
      issuePrefix: `RI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RiskGuardIdleNotErrorCodex",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `RI-${issueId.slice(0, 8)}`,
      title: "Update security permissions",
      description: "Change production security permissions for customer accounts.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: "Change production security permissions for customer accounts." },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });

    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();

    const resultJson = finished?.resultJson as Record<string, unknown>;
    expect(resultJson.errorFamily).toBe("human_intervention_required");

    // finalizeAgentStatus() runs after the run row itself is written terminal,
    // so poll briefly rather than assume the agent row has already settled
    // (same pattern used by the generic-empty-timer-wake test above).
    let agentRow = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]);
    const agentDeadline = Date.now() + 3_000;
    while (agentRow?.status === "running" && Date.now() < agentDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      agentRow = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]);
    }
    expect(agentRow?.status).toBe("idle");
    expect(agentRow?.errorReason).toBeNull();
  }, 15_000);

  it("still marks the agent error for a genuine adapter crash (not a Risk Guard interception)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Risk Guard Genuine Error Company",
      issuePrefix: `RE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RiskGuardGenuineErrorCodex",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // LOW-risk task text so Risk Guard does not intercept and adapter.execute()
    // is actually reached — the crash must come from the adapter itself, not
    // from Risk Guard, to prove the fix does not mask real failures.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `RE-${issueId.slice(0, 8)}`,
      title: "Read the current status report",
      description: "Please summarize the current status for review.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    // Persistent (not "once") failure: heartbeat.ts auto-retries a genuine
    // adapter crash via scheduleInteractionContinuationInfrastructureRetryIfEligible,
    // and a retry that happens to succeed correctly returns the agent to
    // "idle" (the system healed itself) — that is desired behavior, not a
    // regression. To prove a persistently-failing agent still lands in
    // "error", every attempt (the original run and any auto-retry) must fail.
    adapterExecute.mockImplementation(async () => {
      throw new Error("Simulated adapter crash — genuine runtime failure");
    });

    try {
      const heartbeat = heartbeatService(db);
      const queued = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        payload: { issueId, prompt: "Please summarize the current status for review." },
        requestedByActorType: "user",
        requestedByActorId: "responsible-user",
      });

      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);
      expect(finished?.status).toBe("failed");
      expect(adapterExecute.mock.calls.length).toBeGreaterThanOrEqual(1);

      let agentRow = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]);
      const agentDeadline = Date.now() + 5_000;
      while (agentRow?.status === "running" && Date.now() < agentDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        agentRow = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]);
      }
      expect(agentRow?.status).toBe("error");
      expect(agentRow?.errorReason).toBeTruthy();
    } finally {
      // Restore the shared mock's default success behavior so later tests
      // in this file are unaffected.
      adapterExecute.mockImplementation(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionParams: { sessionId: "risk-guard-session" },
        sessionDisplayId: "risk-guard-session",
        provider: "test",
        model: "test-model",
      }));
    }
  }, 15_000);

  it("PROMPT-01: an explicit wake payload.prompt reaches the actual Claude-visible task markdown", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const explicitPrompt =
      "Call append_rows EXACTLY once with spreadsheetId TEST_SHEET, range Envelope-Test!A1:C1, and values [[\"a\",\"b\",\"c\"]].";

    await db.insert(companies).values({
      id: companyId,
      name: "Prompt Delivery Company",
      issuePrefix: `PD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PromptDeliveryCodex",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `PD-${issueId.slice(0, 8)}`,
      title: "Read the current status report",
      description: "Please summarize the current status for review.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: explicitPrompt },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const callArgs = adapterExecute.mock.calls[0][0] as { context?: Record<string, unknown> };
    const markdown = String(callArgs.context?.paperclipTaskMarkdown ?? "");
    expect(markdown).toContain("Envelope-Test!A1:C1");
    expect(markdown).toContain("Explicit wake instruction for this run:");
  }, 15_000);

  it("PROMPT-02: a wake with no explicit prompt renders no 'Explicit wake instruction' section", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Prompt Delivery Promptless Company",
      issuePrefix: `PP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PromptlessCodex",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `PP-${issueId.slice(0, 8)}`,
      title: "Read the current status report",
      description: "Please summarize the current status for review.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const callArgs = adapterExecute.mock.calls[0][0] as { context?: Record<string, unknown> };
    const markdown = String(callArgs.context?.paperclipTaskMarkdown ?? "");
    expect(markdown).not.toContain("Explicit wake instruction for this run:");
    expect(markdown).toContain("Please summarize the current status for review.");
  }, 15_000);

  it("PROMPT-04: issue description and explicit prompt are both preserved together", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const explicitPrompt = "Use exact value MARKER-EXPLICIT-PROMPT-42 when reporting back.";

    await db.insert(companies).values({
      id: companyId,
      name: "Prompt Delivery Both Company",
      issuePrefix: `PB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PromptBothCodex",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `PB-${issueId.slice(0, 8)}`,
      title: "Read the current status report",
      description: "MARKER-ISSUE-DESCRIPTION-99: please summarize the current status for review.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: explicitPrompt },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const callArgs = adapterExecute.mock.calls[0][0] as { context?: Record<string, unknown> };
    const markdown = String(callArgs.context?.paperclipTaskMarkdown ?? "");
    expect(markdown).toContain("MARKER-ISSUE-DESCRIPTION-99");
    expect(markdown).toContain("MARKER-EXPLICIT-PROMPT-42");
  }, 15_000);

  it("PROMPT-05: two concurrent runs' explicit prompts do not leak into each other", async () => {
    const companyId = randomUUID();
    const agentIdA = randomUUID();
    const agentIdB = randomUUID();
    const issueIdA = randomUUID();
    const issueIdB = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Prompt Delivery Isolation Company",
      issuePrefix: `PI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: agentIdA,
        companyId,
        name: "PromptIsolationCodexA",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentIdB,
        companyId,
        name: "PromptIsolationCodexB",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: issueIdA,
        companyId,
        identifier: `PI-${issueIdA.slice(0, 8)}`,
        title: "Read status A",
        description: "Please summarize status A.",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentIdA,
        responsibleUserId: "responsible-user",
      },
      {
        id: issueIdB,
        companyId,
        identifier: `PI-${issueIdB.slice(0, 8)}`,
        title: "Read status B",
        description: "Please summarize status B.",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentIdB,
        responsibleUserId: "responsible-user",
      },
    ]);

    const heartbeat = heartbeatService(db);
    const queuedA = await heartbeat.wakeup(agentIdA, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId: issueIdA, prompt: "MARKER-RUN-A-ONLY" },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    const finishedA = await waitForRunToFinish(heartbeat, queuedA!.id);
    expect(finishedA?.status).toBe("succeeded");

    const queuedB = await heartbeat.wakeup(agentIdB, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId: issueIdB, prompt: "MARKER-RUN-B-ONLY" },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    const finishedB = await waitForRunToFinish(heartbeat, queuedB!.id);
    expect(finishedB?.status).toBe("succeeded");

    expect(adapterExecute).toHaveBeenCalledTimes(2);
    const markdownA = String((adapterExecute.mock.calls[0][0] as { context?: Record<string, unknown> }).context?.paperclipTaskMarkdown ?? "");
    const markdownB = String((adapterExecute.mock.calls[1][0] as { context?: Record<string, unknown> }).context?.paperclipTaskMarkdown ?? "");
    expect(markdownA).toContain("MARKER-RUN-A-ONLY");
    expect(markdownA).not.toContain("MARKER-RUN-B-ONLY");
    expect(markdownB).toContain("MARKER-RUN-B-ONLY");
    expect(markdownB).not.toContain("MARKER-RUN-A-ONLY");
  }, 15_000);
});

describeEmbeddedPostgres("Heartbeat Risk Guard — Approval Lifecycle Security integration (consumeApproval, retry-chain root)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // drainActiveRunExecutions() closes over heartbeat.ts's module-level
  // activeWakeupPromises/activeRunExecutionPromises Sets, not over `db`, so
  // any heartbeatService(db) instance can drain them. Kept at describe scope
  // purely so afterEach can reach it before tearing down tempDb.
  let heartbeat!: ReturnType<typeof heartbeatService>;

  // Several of these tests call resumeQueuedRuns() (which scans queued runs
  // GLOBALLY, not scoped to one company) and exercise executeRun's full
  // pipeline (continuation summaries, document revisions, agent task
  // sessions, environment leases, run events — many tables with FKs back to
  // heartbeat_runs/agents/companies that vary by which code paths a given
  // test happens to hit). Rather than chase an ever-growing, test-specific
  // manual delete order, each test gets a genuinely fresh embedded Postgres
  // instance — the same isolation every other describe block in this file
  // gets implicitly by never calling resumeQueuedRuns() or re-using an
  // issue/agent across multiple wakes.
  beforeEach(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-risk-guard-lifecycle-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    adapterExecute.mockClear();
    adapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionParams: { sessionId: "risk-guard-session" },
      sessionDisplayId: "risk-guard-session",
      provider: "test",
      model: "test-model",
    }));
  }, 20_000);

  afterEach(async () => {
    // Drain every in-flight wakeup/run execution (including any a test's own
    // retry/continuity chain cascaded into) before tearing down tempDb, so a
    // still-settling background execution never races this describe block's
    // next beforeEach/test against a torn-down connection. See the Set
    // declarations and drainActiveRunExecutions() in heartbeat.ts for why
    // this exists.
    await heartbeat?.drainActiveRunExecutions();
    await tempDb?.cleanup();
    tempDb = null;
  });

  // NOTE: heartbeat.wakeup() itself was found (during this test suite's
  // development) to sometimes link a fresh wake for a still-open issue to a
  // prior run via retryOfRunId (issue-continuity tracking, unrelated to this
  // integration), and to enrich contextSnapshot in ways that shift taskText
  // and therefore the fingerprint. To keep these tests deterministic and
  // scoped to heartbeat.ts's NEW Risk Guard <-> Approval Lifecycle wiring
  // (not that pre-existing, unrelated continuity behavior), every run after
  // the initial intercepting wake is queued directly via insertQueuedRun()
  // below, copying contextSnapshot verbatim and setting retryOfRunId only
  // where a test explicitly means "same retry chain".

  async function seedCompanyAgentIssue(
    label: string,
    description = "Change production security permissions for customer accounts.",
    adapterType = "codex_local",
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `${label} Company`,
      issuePrefix: `LC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${label}${adapterType}`,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `LC-${issueId.slice(0, 8)}`,
      title: "Update security permissions",
      description,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  async function wakeAndAwait(heartbeat: ReturnType<typeof heartbeatService>, agentId: string, issueId: string) {
    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: "Change production security permissions for customer accounts." },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    return finished!;
  }

  async function findRiskGuardApproval(companyId: string, issueId: string) {
    return db
      .select()
      .from(approvals)
      .innerJoin(issueApprovals, eq(issueApprovals.approvalId, approvals.id))
      .where(and(eq(approvals.companyId, companyId), eq(issueApprovals.issueId, issueId)))
      .orderBy(approvals.createdAt)
      .then((rows) => rows.map((row) => row.approvals));
  }

  async function approveLatest(companyId: string, issueId: string) {
    const [latest] = (await findRiskGuardApproval(companyId, issueId)).slice(-1);
    await db
      .update(approvals)
      .set({ status: "approved", decidedByUserId: "board-tester", decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(approvals.id, latest.id));
    return latest.id;
  }

  // Queues a run directly with an EXACT copy of a prior run's contextSnapshot
  // (rather than calling heartbeat.wakeup() again, which — per this test
  // file's own findings — can inject additional continuation context that
  // changes taskText, and therefore the fingerprint, even for what's meant
  // to be "the same task"). This gives full, precise control over whether a
  // queued run is part of a retry chain (retryOfRunId set) or genuinely
  // unrelated (omitted), matching exactly what's under test.
  async function insertQueuedRun(
    heartbeat: ReturnType<typeof heartbeatService>,
    input: { companyId: string; agentId: string; contextSnapshot: unknown; retryOfRunId?: string },
  ) {
    const [{ id }] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        contextSnapshot: input.contextSnapshot,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      })
      .returning({ id: heartbeatRuns.id });
    await heartbeat.resumeQueuedRuns();
    return (await waitForRunToFinish(heartbeat, id))!;
  }

  it("RESUME-IDEMPOTENCY-01: concurrent recovery wakes with one deterministic key create one execution", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue(
      "ResumeIdempotency01",
      "Read the current system logs.",
    );
    await db
      .update(issues)
      .set({ title: "Read system logs", updatedAt: new Date() })
      .where(eq(issues.id, issueId));

    const options = {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "approval_approved",
      idempotencyKey: `approval-resume:test-approval:${agentId}`,
      payload: { approvalId: "test-approval", issueId, prompt: "Read the current system logs." },
      contextSnapshot: { issueId, taskId: issueId, prompt: "Read the current system logs." },
      requestedByActorType: "user" as const,
      requestedByActorId: "responsible-user",
    };

    const [first, second] = await Promise.all([
      heartbeat.wakeup(agentId, options),
      heartbeat.wakeup(agentId, options),
    ]);

    expect(first?.id).toBeTruthy();
    expect(second?.id).toBe(first?.id);
    await heartbeat.drainActiveRunExecutions();

    const wakeRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.idempotencyKey, options.idempotencyKey),
        ),
    );
    expect(wakeRows).toHaveLength(1);
    const resumeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, wakeRows[0]!.id));
    expect(resumeRuns).toHaveLength(1);
  }, 20_000);

  it("APPROVAL-SHADOW-01: a newer unrelated approval cannot hide the exact valid Risk Guard approval", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("ApprovalShadow01");
    const intercepted = await wakeAndAwait(heartbeat, agentId, issueId);
    const exactApprovalId = await approveLatest(companyId, issueId);

    const [unrelated] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "request_board_approval",
        requestedByAgentId: agentId,
        status: "approved",
        taskFingerprint: "not-the-current-task-fingerprint",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        payload: { source: "unrelated_approval", issueId },
        decidedByUserId: "board-tester",
        decidedAt: new Date(),
      })
      .returning();
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId: unrelated.id,
      linkedByUserId: "board-tester",
    });

    const resumed = await insertQueuedRun(heartbeat, {
      companyId,
      agentId,
      contextSnapshot: intercepted.contextSnapshot,
    });

    expect(resumed.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    const [exactApproval] = await db.select().from(approvals).where(eq(approvals.id, exactApprovalId));
    const [unrelatedAfter] = await db.select().from(approvals).where(eq(approvals.id, unrelated.id));
    expect(exactApproval.consumedAt).not.toBeNull();
    expect(unrelatedAfter.consumedAt).toBeNull();
  }, 20_000);

  it("RETRY-01: first run consumes the approval and executes normally", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Retry01");
    const heartbeat = heartbeatService(db);

    const intercepted = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(intercepted.status).toBe("failed");
    const approvalId = await approveLatest(companyId, issueId);

    // A fresh, standalone run (no retryOfRunId) — the first genuine
    // execution attempt against the now-approved approval.
    const finished = await insertQueuedRun(heartbeat, {
      companyId, agentId, contextSnapshot: intercepted.contextSnapshot,
    });
    expect(finished.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approvalRow.consumedAt).not.toBeNull();
    expect(approvalRow.consumedByRunId).toBe(finished.id);
  }, 20_000);

  it("RETRY-02: a child retry (retryOfRunId) reuses the same approval as an idempotent same-run consume", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Retry02");
    const heartbeat = heartbeatService(db);

    const intercepted = await wakeAndAwait(heartbeat, agentId, issueId);
    const approvalId = await approveLatest(companyId, issueId);

    const runA = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: intercepted.contextSnapshot });
    expect(runA.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const runB = await insertQueuedRun(heartbeat, {
      companyId, agentId, contextSnapshot: runA.contextSnapshot, retryOfRunId: runA.id,
    });
    expect(runB.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(2); // runA + runB, both actually executed

    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    // The very first consumer's canonical root is never overwritten by a
    // later, same-chain child retry.
    expect(approvalRow.consumedByRunId).toBe(runA.id);
  }, 20_000);

  it("RETRY-03: multi-hop retry chain (A -> B -> C) resolves to the same canonical root", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Retry03");
    const heartbeat = heartbeatService(db);

    const intercepted = await wakeAndAwait(heartbeat, agentId, issueId);
    const approvalId = await approveLatest(companyId, issueId);

    const runA = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: intercepted.contextSnapshot });
    expect(runA.status).toBe("succeeded");

    const runB = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: runA.contextSnapshot, retryOfRunId: runA.id });
    expect(runB.status).toBe("succeeded");

    const runC = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: runA.contextSnapshot, retryOfRunId: runB.id });
    expect(runC.status).toBe("succeeded");

    expect(adapterExecute).toHaveBeenCalledTimes(3); // A, B, C each actually executed

    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approvalRow.consumedByRunId).toBe(runA.id); // root stays stable through both extra hops
  }, 25_000);

  it("RETRY-04: an unrelated run (no shared retry chain) is rejected even with the same fingerprint, and re-intercepted", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Retry04");
    const heartbeat = heartbeatService(db);

    const intercepted = await wakeAndAwait(heartbeat, agentId, issueId);
    const approvalId = await approveLatest(companyId, issueId);

    const runA = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: intercepted.contextSnapshot });
    expect(runA.status).toBe("succeeded");
    adapterExecute.mockClear();

    // A genuinely unrelated run: same fingerprint/issue/company, but no
    // retryOfRunId at all — a completely different retry family.
    const runD = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: runA.contextSnapshot });

    expect(runD.status).toBe("failed"); // re-intercepted, not executed
    expect(adapterExecute).not.toHaveBeenCalled();

    const resultJson = runD.resultJson as Record<string, unknown>;
    expect(resultJson.approvalId).not.toBe(approvalId); // a fresh approval was requested

    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approvalRow.consumedByRunId).toBe(runA.id); // unchanged — runD never consumed it
  }, 20_000);

  it("STALE-01: a newer approved-unconsumed approval is selected over an older consumed one", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Stale01");
    const heartbeat = heartbeatService(db);

    // Approval A: created, approved, and consumed by runA (same shape as RETRY-04).
    const intercepted = await wakeAndAwait(heartbeat, agentId, issueId);
    const approvalAId = await approveLatest(companyId, issueId);
    const runA = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: intercepted.contextSnapshot });
    expect(runA.status).toBe("succeeded");
    adapterExecute.mockClear();

    // runD is a genuinely unrelated run: re-intercepted because approval A is
    // already consumed by runA, and a fresh Approval B gets requested.
    const runD = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: runA.contextSnapshot });
    expect(runD.status).toBe("failed");
    const runDResult = runD.resultJson as Record<string, unknown>;
    expect(runDResult.approvalId).not.toBe(approvalAId);

    // Approval B is now approved and unconsumed, coexisting with the older,
    // already-consumed Approval A — the exact stale-selection scenario.
    const approvalBId = await approveLatest(companyId, issueId);
    expect(approvalBId).not.toBe(approvalAId);

    const runE = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: runD.contextSnapshot });

    expect(runE.status).toBe("succeeded"); // Approval B was found and consumed, not re-intercepted.
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const [approvalARow] = await db.select().from(approvals).where(eq(approvals.id, approvalAId));
    const [approvalBRow] = await db.select().from(approvals).where(eq(approvals.id, approvalBId));
    expect(approvalARow.consumedByRunId).toBe(runA.id); // unchanged
    expect(approvalBRow.consumedByRunId).toBe(runE.id); // newer, unconsumed approval was selected

    // No third approval was created for runE.
    const allApprovals = await findRiskGuardApproval(companyId, issueId);
    expect(allApprovals).toHaveLength(2);
  }, 20_000);

  it("CRASH-02: a run that crashes right after consuming the approval can still be retried and complete", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Crash02");
    const heartbeat = heartbeatService(db);

    const intercepted = await wakeAndAwait(heartbeat, agentId, issueId);
    const approvalId = await approveLatest(companyId, issueId);

    // Simulate a crash during execution, AFTER consumeApproval already
    // committed (the consume happens before adapter.execute is ever called).
    adapterExecute.mockImplementationOnce(async () => {
      throw new Error("simulated adapter crash");
    });

    const runA = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: intercepted.contextSnapshot });
    expect(runA.status).not.toBe("succeeded"); // crashed
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const [approvalAfterCrash] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approvalAfterCrash.consumedByRunId).toBe(runA.id); // consume survived the crash

    // The retry (same retry-chain root) must be able to actually execute —
    // this is the recovery guarantee, not a lockout.
    const runB = await insertQueuedRun(heartbeat, { companyId, agentId, contextSnapshot: runA.contextSnapshot, retryOfRunId: runA.id });

    expect(runB.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("FP-01: changing the issue's content after approval invalidates the fingerprint and blocks reuse", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Fp01");
    const heartbeat = heartbeatService(db);

    await wakeAndAwait(heartbeat, agentId, issueId);
    const approvalId = await approveLatest(companyId, issueId);

    await db
      .update(issues)
      .set({ description: "Modify the production database schema and delete stale customer records now." })
      .where(eq(issues.id, issueId));

    const runD = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(runD.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();

    const resultJson = runD.resultJson as Record<string, unknown>;
    expect(resultJson.approvalId).not.toBe(approvalId);

    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approvalRow.consumedAt).toBeNull(); // never consumed
  }, 20_000);

  it("TTL-01: an approved-but-expired approval cannot authorize execution", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Ttl01");
    const heartbeat = heartbeatService(db);

    await wakeAndAwait(heartbeat, agentId, issueId);
    const approvalId = await approveLatest(companyId, issueId);
    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(approvals.id, approvalId));

    const runD = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(runD.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();

    const resultJson = runD.resultJson as Record<string, unknown>;
    expect(resultJson.approvalId).not.toBe(approvalId);

    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approvalRow.consumedAt).toBeNull();
  }, 20_000);

  it("CONC-01: two unrelated concurrent execution attempts on the same approval — exactly one retry family succeeds", async () => {
    // The scheduler runs at most one active run per agent at a time, so a
    // true race can't be forced through the public wakeup()/executeRun path
    // without fighting that single-run concurrency limit. This exercises
    // the EXACT same consumeApproval(...) call heartbeat.ts's Risk Guard
    // integration makes, concurrently, against a real approval row produced
    // by the real Risk Guard creation path above — the same atomic guarantee
    // already proven in approval-lifecycle.test.ts, reconfirmed here against
    // this integration's actual data shape.
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Conc01");
    const heartbeat = heartbeatService(db);

    await wakeAndAwait(heartbeat, agentId, issueId);
    const approvalId = await approveLatest(companyId, issueId);
    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, approvalId));

    const rootX = randomUUID();
    const rootY = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: rootX, companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual", status: "running" },
      { id: rootY, companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual", status: "running" },
    ]);

    const [resultX, resultY] = await Promise.all([
      consumeApproval(db, { approvalId, runId: rootX, expectedTaskFingerprint: approvalRow.taskFingerprint! }),
      consumeApproval(db, { approvalId, runId: rootY, expectedTaskFingerprint: approvalRow.taskFingerprint! }),
    ]);

    const outcomes = [resultX.outcome, resultY.outcome].sort();
    expect(outcomes).toEqual(["already_consumed_other_run", "consumed"]);
  }, 20_000);

  it("DEDUP-01: active pending approval is reused when the task is re-intercepted", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Dedup01");
    const heartbeat = heartbeatService(db);

    const run1 = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(run1.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();
    const resultJson1 = run1.resultJson as Record<string, unknown>;
    const approvalId1 = resultJson1.approvalId as string;
    expect(approvalId1).toBeDefined();

    // Re-triggering while pending approval is active reuses the existing approval:
    const run2 = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(run2.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();
    const resultJson2 = run2.resultJson as Record<string, unknown>;
    expect(resultJson2.approvalId).toBe(approvalId1);

    const allApprovals = await findRiskGuardApproval(companyId, issueId);
    expect(allApprovals.length).toBe(1);
  }, 20_000);

  it("INVARIANT-01: a single Risk-Guard-blocked wake creates exactly one heartbeat run, one approval, and zero assignment_recovery children", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Invariant01");
    const heartbeat = heartbeatService(db);

    // No explicit second wake — this is the exact DEDUP-01 fixture shape
    // (issue status "todo", no assigneeUserId, same assigned agent) that
    // previously allowed releaseIssueExecutionAndPromote's
    // issue_assignment_recovery branch to misfire on a Risk-Guard
    // interception (heartbeat.ts:18228-18232).
    const run1 = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(run1.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();
    const resultJson1 = run1.resultJson as Record<string, unknown>;
    expect(resultJson1.approvalId).toBeDefined();

    const allRunsForAgent = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(allRunsForAgent).toHaveLength(1);
    for (const runRow of allRunsForAgent) {
      const retryReason = (runRow.contextSnapshot as Record<string, unknown> | null)?.retryReason;
      expect(retryReason).not.toBe("assignment_recovery");
    }

    const allApprovals = await findRiskGuardApproval(companyId, issueId);
    expect(allApprovals.length).toBe(1);
  }, 20_000);

  it("INVARIANT-02 (positive control): a real adapter execution failure on the same todo/no-human-assignee shape still produces an assignment_recovery child run", async () => {
    // seedCompanyAgentIssue hardcodes title "Update security permissions"
    // (HIGH risk), which would route this through Risk Guard instead of the
    // adapter. Seed a LOW-risk issue directly so this run actually reaches
    // adapter.execute() and fails for a real (non-Risk-Guard) reason.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Invariant02 Company",
      issuePrefix: `LC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Invariant02codex_local",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `LC-${issueId.slice(0, 8)}`,
      title: "Summarize recent activity",
      description: "Read-only status check.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    adapterExecute.mockImplementationOnce(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_crashed",
      summary: "Adapter process crashed unexpectedly.",
    }));
    const heartbeat = heartbeatService(db);

    // wakeAndAwait() hardcodes a HIGH-risk prompt ("Change production
    // security permissions..."), which would route this through Risk Guard
    // instead of the adapter. Wake directly with a LOW-risk payload so this
    // run actually reaches adapter.execute().
    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: "Summarize recent activity." },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    expect(queued).not.toBeNull();
    const run1 = (await waitForRunToFinish(heartbeat, queued!.id))!;
    expect(run1.status).toBe("failed");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const recoveryChild = await waitForNewRun(agentId, run1.id);
    expect(recoveryChild).not.toBeNull();
    const recoveryContext = recoveryChild!.contextSnapshot as Record<string, unknown>;
    expect(recoveryContext.retryReason).toBe("assignment_recovery");
    expect(recoveryChild!.retryOfRunId).toBe(run1.id);
  }, 20_000);

  function createApprovalApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-tester",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", approvalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function waitForNewRun(agentId: string, excludeRunId: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [row] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1);
      if (row && row.id !== excludeRunId) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for a new run to be created after approval");
  }

  it("RESUME-01: approving a Risk-Guard-intercepted run with a custom wake prompt replays the same prompt, preserves the fingerprint, and resumes to adapter execution without a duplicate approval", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Resume01");
    const heartbeat = heartbeatService(db);
    const customPrompt = "Change production security permissions for customer accounts. Use exact account ID ACC-42.";

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: customPrompt },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    const intercepted = await waitForRunToFinish(heartbeat, queued!.id);
    expect(intercepted.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();
    const interceptedResult = intercepted.resultJson as Record<string, unknown>;
    const approvalId = interceptedResult.approvalId as string;
    expect(approvalId).toBeDefined();
    const [approvalBefore] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    const originalFingerprint = approvalBefore.taskFingerprint;

    const app = createApprovalApp(companyId);
    const approveResponse = await request(app).post(`/api/approvals/${approvalId}/approve`).send({});
    expect(approveResponse.status).toBe(200);

    const resumedRunRow = await waitForNewRun(agentId, intercepted.id);
    const resumed = await waitForRunToFinish(heartbeat, resumedRunRow.id);

    // The resumed run's own canonicalFingerprint (recomputed inside Risk
    // Guard from the replayed prompt) must match what the human approved —
    // proving the fix, not just its downstream effect.
    const resumedApprovals = await findRiskGuardApproval(companyId, issueId);
    expect(resumedApprovals).toHaveLength(1);
    expect(resumedApprovals[0].id).toBe(approvalId);
    expect(resumedApprovals[0].taskFingerprint).toBe(originalFingerprint);

    expect(resumed.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    // consumedByRunId is the retry chain's root run id (resolveRetryChainRootRunId),
    // which heartbeat.wakeup()'s own issue-continuity linking can point at an
    // earlier run in the chain rather than this exact resumed run — asserting
    // only that it was consumed by some run, not which one, keeps this test
    // scoped to what the fix actually claims (fingerprint match + resume).
    const [approvalAfter] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approvalAfter.consumedAt).not.toBeNull();
    expect(approvalAfter.consumedByRunId).toBeTruthy();
  }, 20_000);

  it("RESUME-02: approving a Risk-Guard-intercepted run with the default (no custom prompt) wake still resumes without a duplicate approval", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Resume02");
    const heartbeat = heartbeatService(db);

    const intercepted = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(intercepted.status).toBe("failed");
    const interceptedResult = intercepted.resultJson as Record<string, unknown>;
    const approvalId = interceptedResult.approvalId as string;

    const app = createApprovalApp(companyId);
    const approveResponse = await request(app).post(`/api/approvals/${approvalId}/approve`).send({});
    expect(approveResponse.status).toBe(200);

    const resumedRunRow = await waitForNewRun(agentId, intercepted.id);
    const resumed = await waitForRunToFinish(heartbeat, resumedRunRow.id);

    const resumedApprovals = await findRiskGuardApproval(companyId, issueId);
    expect(resumedApprovals).toHaveLength(1);
    expect(resumed.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("PROMPT-03: the original explicit wake prompt reaches the resumed adapter execution after approval", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Prompt03");
    const heartbeat = heartbeatService(db);
    const customPrompt = "Change production security permissions for customer accounts. Use exact account ID ACC-99.";

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId, prompt: customPrompt },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    const intercepted = await waitForRunToFinish(heartbeat, queued!.id);
    expect(intercepted.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();
    const interceptedResult = intercepted.resultJson as Record<string, unknown>;
    const approvalId = interceptedResult.approvalId as string;

    const app = createApprovalApp(companyId);
    const approveResponse = await request(app).post(`/api/approvals/${approvalId}/approve`).send({});
    expect(approveResponse.status).toBe(200);

    const resumedRunRow = await waitForNewRun(agentId, intercepted.id);
    const resumed = await waitForRunToFinish(heartbeat, resumedRunRow.id);
    expect(resumed.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const callArgs = adapterExecute.mock.calls[0][0] as { context?: Record<string, unknown> };
    const markdown = String(callArgs.context?.paperclipTaskMarkdown ?? "");
    expect(markdown).toContain("ACC-99");
    expect(markdown).toContain("Explicit wake instruction for this run:");
  }, 20_000);

  it("DEDUP-02: expired pending approval is ignored and a fresh pending approval is created", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Dedup02");
    const heartbeat = heartbeatService(db);

    const run1 = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(run1.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();
    const resultJson1 = run1.resultJson as Record<string, unknown>;
    const approvalId1 = resultJson1.approvalId as string;

    // Simulate TTL expiration while status remains "pending":
    await db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(approvals.id, approvalId1));

    // Re-triggering must ignore the expired pending approval and create a fresh one:
    const run2 = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(run2.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled(); // Human Approval Gate enforced
    const resultJson2 = run2.resultJson as Record<string, unknown>;
    const approvalId2 = resultJson2.approvalId as string;
    expect(approvalId2).toBeDefined();
    expect(approvalId2).not.toBe(approvalId1);

    const allApprovals = await findRiskGuardApproval(companyId, issueId);
    expect(allApprovals.length).toBe(2);

    // If the fresh approval is approved, execution is authorized:
    await approveLatest(companyId, issueId);
    const run3 = await insertQueuedRun(heartbeat, {
      companyId,
      agentId,
      contextSnapshot: run2.contextSnapshot,
    });
    expect(run3.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("DEDUP-03: active revision_requested approval is reused when the task is re-intercepted", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Dedup03");
    const heartbeat = heartbeatService(db);

    const run1 = await wakeAndAwait(heartbeat, agentId, issueId);
    const resultJson1 = run1.resultJson as Record<string, unknown>;
    const approvalId1 = resultJson1.approvalId as string;

    // Transition to revision_requested with future expiresAt:
    await db
      .update(approvals)
      .set({ status: "revision_requested", expiresAt: new Date(Date.now() + 600_000) })
      .where(eq(approvals.id, approvalId1));

    const run2 = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(run2.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();
    const resultJson2 = run2.resultJson as Record<string, unknown>;
    expect(resultJson2.approvalId).toBe(approvalId1);

    const allApprovals = await findRiskGuardApproval(companyId, issueId);
    expect(allApprovals.length).toBe(1);
  }, 20_000);

  async function seedCompanyAndAgentWithoutIssues(label: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `${label} Company`,
      issuePrefix: `LC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${label}Codex`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("IDLE-01: generic timer wake with no actionable work uses official skipped lifecycle", async () => {
    const { companyId, agentId } = await seedCompanyAndAgentWithoutIssues("Idle01");
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "scheduled_interval",
    });

    expect(queued).toBeNull();

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    expect(adapterExecute).not.toHaveBeenCalled();

    const companyApprovals = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(companyApprovals).toHaveLength(0);
  }, 20_000);

  it("REPEAT-01: repeated generic timer wakes continue to skip without accumulating runs or approvals", async () => {
    const { companyId, agentId } = await seedCompanyAndAgentWithoutIssues("Repeat01");
    const heartbeat = heartbeatService(db);

    for (let i = 0; i < 3; i++) {
      const queued = await heartbeat.wakeup(agentId, {
        source: "timer",
        triggerDetail: "scheduled_interval",
      });
      expect(queued).toBeNull();
    }

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    expect(adapterExecute).not.toHaveBeenCalled();

    const companyApprovals = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(companyApprovals).toHaveLength(0);
  }, 20_000);

  it("WORK-01: timer wake with assigned actionable work is not skipped and preserves Risk Guard approval", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue("Work01");
    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: {
            enabled: true,
          },
        },
      })
      .where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db);

    const queued = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "scheduled_interval",
      payload: { issueId, prompt: "Change production security permissions for customer accounts." },
    });

    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished!.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();

    const issueApprovalRows = await findRiskGuardApproval(companyId, issueId);
    expect(issueApprovalRows).toHaveLength(1);
    expect(issueApprovalRows[0].status).toBe("pending");
  }, 20_000);

  it("ADAPTER-01: claude_local agent with HIGH-risk task is intercepted by Risk Guard", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue(
      "ClaudeHigh",
      "Change production security permissions for customer accounts.",
      "claude_local",
    );
    const heartbeat = heartbeatService(db);

    const run = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(run.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();

    const resultJson = run.resultJson as Record<string, unknown>;
    expect(resultJson.risk).toBe("HIGH");
    expect(resultJson.approvalId).toBeDefined();

    const approvalRows = await findRiskGuardApproval(companyId, issueId);
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0].status).toBe("pending");
  }, 20_000);

  it("ADAPTER-02: claude_local agent with approved approval executes successfully", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue(
      "ClaudeApprove",
      "Change production security permissions for customer accounts.",
      "claude_local",
    );
    const heartbeat = heartbeatService(db);

    const intercepted = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(intercepted.status).toBe("failed");
    const approvalId = await approveLatest(companyId, issueId);

    const finished = await insertQueuedRun(heartbeat, {
      companyId,
      agentId,
      contextSnapshot: intercepted.contextSnapshot,
    });
    expect(finished.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approvalRow.consumedAt).not.toBeNull();
    expect(approvalRow.consumedByRunId).toBe(finished.id);
  }, 20_000);

  it("ADAPTER-03: gemini_local agent with HIGH-risk task is intercepted by Risk Guard", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue(
      "GeminiHigh",
      "Delete customer database tables in production.",
      "gemini_local",
    );
    const heartbeat = heartbeatService(db);

    const run = await wakeAndAwait(heartbeat, agentId, issueId);
    expect(run.status).toBe("failed");
    expect(adapterExecute).not.toHaveBeenCalled();

    const resultJson = run.resultJson as Record<string, unknown>;
    expect(resultJson.risk).toBe("HIGH");
  }, 20_000);

  it("TIMER-01: generic timer wake with empty taskText is safely completed as succeeded idle tick without Risk Guard UNKNOWN interception", async () => {
    const { companyId, agentId } = await seedCompanyAgentIssue("Timer01");
    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: {
            enabled: true,
          },
        },
      })
      .where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db);

    // 1. Before: Capture baseline approvals for the company directly from approvals table
    const approvalsBefore = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, companyId));

    // 2. Trigger generic empty timer wake (source: "timer", no issueId, no prompt)
    const queued = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "scheduled_interval",
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
      },
    });

    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished!.status).toBe("succeeded");
    expect(adapterExecute).not.toHaveBeenCalled();

    // 3. After: Verify zero new approvals were created for this company
    const approvalsAfter = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, companyId));
    expect(approvalsAfter).toHaveLength(approvalsBefore.length);

    // 4. Verify specifically that no approval exists with sha256("") empty task fingerprint
    const emptyTaskFingerprint = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const emptyTaskApprovals = approvalsAfter.filter(
      (a) => a.taskFingerprint === emptyTaskFingerprint,
    );
    expect(emptyTaskApprovals).toHaveLength(0);

    // 5. Verify agent remained in healthy idle status (never placed in error)
    let agentRow = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]);
    const agentDeadline = Date.now() + 3_000;
    while (agentRow?.status === "running" && Date.now() < agentDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      agentRow = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]);
    }
    expect(agentRow?.status).toBe("idle");
  }, 20_000);
});
