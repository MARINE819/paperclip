import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { voiceRoutes } from "../routes/voice.js";
import { errorHandler } from "../middleware/index.js";
import { isApprovalOnlyBoardKeyRequestAllowed } from "../routes/authz.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres voice command tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("Voice Control & Multimodal Interface (Stage 10 Server Suite)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = "11111111-1111-4111-8111-111111111111";
  const otherCompanyId = "22222222-2222-4222-8222-222222222222";
  const userId = "user-1111-1111-1111";
  const otherUserId = "user-2222-2222-2222";
  const agentId = "11111111-1111-4111-8111-111111111112";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("voice-commands-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTestData() {
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Nexora Corp",
        status: "active",
        issuePrefix: "NEX",
        budgetMonthlyCents: 100000, // $1,000.00
      },
      {
        id: otherCompanyId,
        name: "Other Corp",
        status: "active",
        issuePrefix: "OTH",
        budgetMonthlyCents: 50000,
      },
    ]);

    await db.insert(companyMemberships).values([
      {
        companyId,
        principalType: "user",
        principalId: userId,
        membershipRole: "owner",
        status: "active",
      },
      {
        companyId: otherCompanyId,
        principalType: "user",
        principalId: otherUserId,
        membershipRole: "owner",
        status: "active",
      },
    ]);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Autonomous Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
    });

    // Seed some issues for work status verification
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Build Stage 10 Voice Gateway",
        status: "in_progress",
        issueNumber: 1,
        identifier: "NEX-1",
      },
      {
        id: randomUUID(),
        companyId,
        title: "Review Security Boundaries",
        status: "todo",
        issueNumber: 2,
        identifier: "NEX-2",
      },
      {
        id: randomUUID(),
        companyId,
        title: "Fix Blocked Pipeline",
        status: "blocked",
        issueNumber: 3,
        identifier: "NEX-3",
      },
    ]);
  }

  function createApp(actorOverrides: Partial<Express.Request["actor"]> = {}) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, res: Response, next: NextFunction) => {
      req.actor = {
        type: "board",
        userId,
        source: "session",
        companyIds: [companyId],
        isInstanceAdmin: false,
        ...actorOverrides,
      };

      // Emulate actorMiddleware approval_only central guard
      if (
        req.actor.type === "board" &&
        req.actor.boardKeyScope === "approval_only" &&
        !isApprovalOnlyBoardKeyRequestAllowed(req.method, req.path)
      ) {
        res.status(403).json({
          error: "Forbidden",
          reason: "board_key_scope_approval_only",
        });
        return;
      }

      next();
    });
    app.use("/api", voiceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // 1. status.company
  it("Scenario 1: status.company queries company status and budget with zero mutation", async () => {
    await seedTestData();
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "회사 상태 알려줘" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      matched: true,
      command: "status.company",
      approvalId: null,
    });
    expect(res.body.resultText).toContain("Nexora Corp");
    expect(res.body.resultText).toContain("정상(active)");
    expect(res.body.resultText).toContain("$1,000");

    // Zero mutations in DB
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(c.status).toBe("active");
  });

  // 2. status.work
  it("Scenario 2: status.work queries task counts and pending approvals with zero mutation", async () => {
    await seedTestData();
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "현재 작업 상태 어때?" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      matched: true,
      command: "status.work",
      approvalId: null,
    });
    // Matches 1 in_progress, 1 todo, 1 blocked (total 3 open tasks in dashboardService)
    expect(res.body.resultText).toContain("진행 중인 작업은 1건");
    expect(res.body.resultText).toContain("대기 중인 작업은 3건");
    expect(res.body.resultText).toContain("차단된 작업은 1건");

    // Zero mutations in DB
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(c.status).toBe("active");
  });

  // 3. dangerous action.pause_company creates approval without mutating company status
  it("Scenario 3: action.pause_company creates request_board_approval and leaves company active", async () => {
    await seedTestData();
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "회사 일시 정지해줘" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.matched).toBe(true);
    expect(res.body.command).toBe("action.pause_company");
    expect(typeof res.body.approvalId).toBe("string");
    expect(res.body.resultText).toContain("위험 명령");
    expect(res.body.resultText).toContain("승인 요청");
    expect(res.body.resultText).toContain("자동으로 정지되지 않으며");

    const createdApprovalId = res.body.approvalId;

    // Verify company status in DB is UNCHANGED (still active!)
    const [persistedCompany] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(persistedCompany.status).toBe("active");

    // Verify approval record in DB
    const [persistedApproval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, createdApprovalId));
    expect(persistedApproval).toBeDefined();
    expect(persistedApproval.type).toBe("request_board_approval");
    expect(persistedApproval.status).toBe("pending");

    // Verify exact approval payload contract
    const payload = persistedApproval.payload as Record<string, unknown>;
    expect(payload.title).toBe("Voice Command: Request Authorization to Pause Company");
    expect(payload.source).toBe("voice_control");
    expect(payload.action).toBe("pause_company");
    expect(payload.requestedVia).toBe("voice");
    expect(payload.nextActionOnApproval).toBe(
      "Approval records human authorization only. It does not automatically pause the company. A separate authorized operator action is required to perform the emergency pause.",
    );
    expect(Array.isArray(payload.risks)).toBe(true);
    expect(payload.risks).toEqual([
      "If subsequently paused by an operator, scheduled agent timer ticks (heartbeat) will be suspended.",
      "If subsequently paused by an operator, automated agent wakeups will be suppressed and skipped with reason 'company.inactive'.",
      "If subsequently paused by an operator, queued heartbeat runs will not be dispatched.",
    ]);
  });

  // 4. unknown command fail-closed semantics (HTTP 200 with success: false, matched: false)
  it("Scenario 4: unknown voice command returns HTTP 200 fail-closed business result", async () => {
    await seedTestData();
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "우주선 화성으로 발사해" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: false,
      matched: false,
      command: "unknown",
      resultText:
        '인식할 수 없는 음성 명령입니다: "우주선 화성으로 발사해". 지원되는 명령: 회사 상태 확인, 업무 현황 확인, 회사 일시 정지 권한 요청.',
      error: "UNKNOWN_VOICE_COMMAND",
      approvalId: null,
    });

    // Zero approvals created
    const approvalsList = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(approvalsList.length).toBe(0);

    // Company remains active
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(c.status).toBe("active");
  });

  // 5. Agent actor rejected with 403
  it("Scenario 5: Agent actor is rejected with 403 Forbidden", async () => {
    await seedTestData();
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "회사 상태 알려줘" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board access required");
  });

  // 6. approval_only board key rejected with 403
  it("Scenario 6: approval_only board key is rejected with 403 Forbidden", async () => {
    await seedTestData();
    const app = createApp({
      type: "board",
      source: "board_key",
      boardKeyScope: "approval_only",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "회사 상태 알려줘" });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("board_key_scope_approval_only");
  });

  // 7. Cross-company access rejected with 403
  it("Scenario 7: Cross-company access is rejected with 403 Forbidden", async () => {
    await seedTestData();
    // User only has membership in companyId, not otherCompanyId
    const app = createApp({
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${otherCompanyId}/voice/command`)
      .send({ transcript: "회사 상태 알려줘" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("User does not have access to this company");
  });

  // 8. Audit logging verification
  it("Scenario 8: Audit log records voice_control events for commands and approvals", async () => {
    await seedTestData();
    const app = createApp();

    // Command 1: status.company
    await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "회사 상태 알려줘" });

    // Command 2: action.pause_company
    await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "회사 일시 정지" });

    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));

    const processedLogs = logs.filter((l) => l.action === "voice_control.command_processed");
    expect(processedLogs.length).toBe(2);
    expect(processedLogs.some((l) => (l.details as Record<string, unknown>).command === "status.company")).toBe(
      true,
    );
    expect(processedLogs.some((l) => (l.details as Record<string, unknown>).command === "action.pause_company")).toBe(
      true,
    );

    const approvalLogs = logs.filter((l) => l.action === "voice_control.approval_requested");
    expect(approvalLogs.length).toBe(1);
    expect((approvalLogs[0].details as Record<string, unknown>).action).toBe("pause_company");
  });

  // 9. Malformed transcript validation (400 Bad Request)
  it("Scenario 9: Malformed or missing transcript returns 400 Bad Request", async () => {
    await seedTestData();
    const app = createApp();

    // Empty object
    const res1 = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({});
    expect(res1.status).toBe(400);

    // Empty string
    const res2 = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "" });
    expect(res2.status).toBe(400);

    // Whitespace only
    const res3 = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "   " });
    expect(res3.status).toBe(400);

    // Over 1000 characters
    const res4 = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "a".repeat(1001) });
    expect(res4.status).toBe(400);
  });

  // 10. English voice commands matching
  it("Scenario 10: English voice commands (company status, work status, pause company) match accurately", async () => {
    await seedTestData();
    const app = createApp();

    const resCompany = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "What is the company status?" });
    expect(resCompany.status).toBe(200);
    expect(resCompany.body.command).toBe("status.company");

    const resWork = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "Report task status" });
    expect(resWork.status).toBe(200);
    expect(resWork.body.command).toBe("status.work");

    const resPause = await request(app)
      .post(`/api/companies/${companyId}/voice/command`)
      .send({ transcript: "Please pause company now" });
    expect(resPause.status).toBe(200);
    expect(resPause.body.command).toBe("action.pause_company");
    expect(typeof resPause.body.approvalId).toBe("string");
  });
});
