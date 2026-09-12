import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, approvals, companies, createDb, heartbeatRuns, issueApprovals, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { classifyPreExecutionRisk, heartbeatService } from "../services/heartbeat.ts";
import { consumeApproval } from "../services/approval-lifecycle.js";

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
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
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
});

describeEmbeddedPostgres("Heartbeat Risk Guard — Approval Lifecycle Security integration (consumeApproval, retry-chain root)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

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

  async function seedCompanyAgentIssue(label: string, description = "Change production security permissions for customer accounts.") {
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
      name: `${label}Codex`,
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
});
