import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/index.js";
import { isApprovalOnlyBoardKeyRequestAllowed } from "../routes/authz.js";
import { heartbeatService } from "../services/heartbeat.js";
import * as webauthnModule from "../services/webauthn-service.js";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(async () => ({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres emergency resume recovery tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("Emergency Pause & Resume Recovery Pipeline (14 Core Scenarios)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = "11111111-1111-4111-8111-111111111111";
  const otherCompanyId = "22222222-2222-4222-8222-222222222222";
  const userId = "user-1111-1111-1111";
  const otherUserId = "user-2222-2222-2222";
  const agentId = "11111111-1111-4111-8111-111111111112";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("emergency-resume-recovery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(webauthnChallenges);
    await db.delete(webauthnCredentials);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBaseData(initialStatus: "active" | "paused" = "active") {
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Acme Corp",
        status: initialStatus,
        issuePrefix: "ACM",
        budgetMonthlyCents: 0,
      },
      {
        id: otherCompanyId,
        name: "Other Corp",
        status: "paused",
        issuePrefix: "OTH",
        budgetMonthlyCents: 0,
      },
    ]);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker Agent",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
    });

    await db.insert(webauthnCredentials).values([
      {
        companyId,
        userId,
        credentialId: "cred-test-id-1",
        publicKey: Buffer.from("mock-public-key-1").toString("base64url"),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        name: "Mobile Face ID",
      },
      {
        companyId,
        userId: otherUserId,
        credentialId: "cred-test-id-2",
        publicKey: Buffer.from("mock-public-key-2").toString("base64url"),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        name: "Other User Face ID",
      },
      {
        companyId: otherCompanyId,
        userId,
        credentialId: "cred-test-id-other-co",
        publicKey: Buffer.from("mock-public-key-other-co").toString("base64url"),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        name: "Other Co Face ID",
      },
    ]);
  }

  // Official WebAuthn token issuance path (Zero direct helper bypass)
  async function obtainOfficialResumeToken(
    targetCompanyId: string,
    targetUserId: string,
    credentialId = "cred-test-id-1",
  ): Promise<string> {
    const webauthn = webauthnModule.webauthnService(db);
    const options = await webauthn.generateAuthenticationOptions({
      companyId: targetCompanyId,
      userId: targetUserId,
      purpose: "emergency_resume",
      bindingId: targetCompanyId,
    });

    const clientDataJSON = Buffer.from(
      JSON.stringify({ challenge: options.challenge, origin: "http://localhost:3100" }),
    ).toString("base64url");

    const result = await webauthn.verifyAuthentication({
      companyId: targetCompanyId,
      userId: targetUserId,
      purpose: "emergency_resume",
      bindingId: targetCompanyId,
      response: {
        id: credentialId,
        rawId: credentialId,
        response: {
          clientDataJSON,
          authenticatorData: "mock-auth-data",
          signature: "mock-sig",
        },
        type: "public-key",
      },
      expectedOrigin: "http://localhost:3100",
      expectedRpId: "localhost",
    });

    if (!result.resumeToken) {
      throw new Error("WebAuthn verification failed to issue resumeToken");
    }
    return result.resumeToken;
  }

  function createApp(actorOverrides: Partial<Express.Request["actor"]> = {}) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.actor = {
        type: "board",
        userId,
        source: "session",
        companyIds: [companyId],
        isInstanceAdmin: true,
        ...actorOverrides,
      };
      next();
    });
    app.use("/api/companies", companyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // Scenario 1: pause 성공 + audit
  it("Scenario 1: POST emergency-pause transitions company from active to paused and logs audit", async () => {
    await seedBaseData("active");
    const app = createApp();

    const res = await request(app).post(`/api/companies/${companyId}/emergency-pause`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paused");

    const [persisted] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(persisted?.status).toBe("paused");

    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(logs.some((l) => l.action === "company.emergency_paused")).toBe(true);
  });

  // Scenario 2: paused 중 heartbeat 차단 실제 런타임 검증
  it("Scenario 2: Paused company actively suppresses heartbeat wakeup", async () => {
    await seedBaseData("paused");
    const heartbeat = heartbeatService(db);

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: "issue-1" },
      requestedByActorType: "system",
      requestedByActorId: "comment_wake",
    });
    expect(wakeResult).toBeNull();

    await expect(
      heartbeat.wakeup(agentId, {
        source: "manual",
        triggerDetail: "user",
        reason: "manual_user_retry",
        payload: {},
        requestedByActorType: "user",
        requestedByActorId: userId,
      }),
    ).rejects.toThrow("Company is not active");
  });

  // Scenario 3: generic PATCH bypass 403 차단
  it("Scenario 3: Generic PATCH paused -> active is blocked with 403 emergency_resume_required", async () => {
    await seedBaseData("paused");
    const app = createApp();

    const res = await request(app)
      .patch(`/api/companies/${companyId}`)
      .send({ status: "active" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Paused companies must be resumed through the emergency resume flow",
      reason: "emergency_resume_required",
    });

    const [persisted] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(persisted?.status).toBe("paused");
  });

  // Scenario 4: resumeToken 없음 (fail-closed)
  it("Scenario 4: POST emergency-resume without resumeToken returns 401 resume_token_required", async () => {
    await seedBaseData("paused");
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/emergency-resume`)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: "WebAuthn emergency resume token is required",
      reason: "resume_token_required",
    });
  });

  // Scenario 5: actor.userId 없음 (fail-closed)
  it("Scenario 5: POST emergency-resume without actor.userId returns 403 resume_user_required", async () => {
    await seedBaseData("paused");
    const app = createApp({ userId: undefined });

    const res = await request(app)
      .post(`/api/companies/${companyId}/emergency-resume`)
      .send({ resumeToken: "token-any" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Authenticated user identity is required for emergency resume",
      reason: "resume_user_required",
    });
  });

  // Scenario 6: cross-company 토큰 거부 (공식 발급 토큰)
  it("Scenario 6: POST emergency-resume with token from different company returns 403 company_mismatch", async () => {
    await seedBaseData("paused");
    const token = await obtainOfficialResumeToken(otherCompanyId, userId, "cred-test-id-other-co");
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/emergency-resume`)
      .send({ resumeToken: token });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("resume_token_binding_mismatch");

    const [persisted] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(persisted?.status).toBe("paused");
  });

  // Scenario 7: cross-user 토큰 거부 (공식 발급 토큰)
  it("Scenario 7: POST emergency-resume with token from different user returns 403 user_mismatch", async () => {
    await seedBaseData("paused");
    const token = await obtainOfficialResumeToken(companyId, otherUserId, "cred-test-id-2");
    const app = createApp({ userId });

    const res = await request(app)
      .post(`/api/companies/${companyId}/emergency-resume`)
      .send({ resumeToken: token });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("resume_token_binding_mismatch");

    const [persisted] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(persisted?.status).toBe("paused");
  });

  // Scenario 8: expired 토큰 거부 (공식 발급 토큰)
  it("Scenario 8: POST emergency-resume with expired token returns 401 token_expired", async () => {
    await seedBaseData("paused");
    const token = await obtainOfficialResumeToken(companyId, userId, "cred-test-id-1");

    await db
      .update(webauthnChallenges)
      .set({ expiresAt: new Date(Date.now() - 5000) })
      .where(eq(webauthnChallenges.challenge, token));

    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${companyId}/emergency-resume`)
      .send({ resumeToken: token });

    expect(res.status).toBe(410);
    expect(res.body.reason).toBe("resume_token_expired");
  });

  // Scenario 9: replay 공격 차단 (공식 발급 토큰)
  it("Scenario 9: POST emergency-resume with already consumed token returns 409 token_already_consumed", async () => {
    await seedBaseData("paused");
    const token = await obtainOfficialResumeToken(companyId, userId, "cred-test-id-1");

    const app = createApp();
    const firstRes = await request(app)
      .post(`/api/companies/${companyId}/emergency-resume`)
      .send({ resumeToken: token });
    expect(firstRes.status).toBe(200);

    // Pause company again to test replay
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));

    const replayRes = await request(app)
      .post(`/api/companies/${companyId}/emergency-resume`)
      .send({ resumeToken: token });

    expect(replayRes.status).toBe(409);
    expect(replayRes.body.reason).toBe("resume_token_already_consumed");
  });

  // Scenario 10: non-paused + token 미소비 (토큰 소진 방지, 공식 발급 토큰)
  it("Scenario 10: POST emergency-resume on active company returns 409 without burning token", async () => {
    await seedBaseData("active");
    const token = await obtainOfficialResumeToken(companyId, userId, "cred-test-id-1");
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/emergency-resume`)
      .send({ resumeToken: token });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("company_not_paused");

    const [challenge] = await db
      .select()
      .from(webauthnChallenges)
      .where(eq(webauthnChallenges.challenge, token));
    expect(challenge?.consumedAt).toBeNull();
  });

  // Scenario 11: concurrency rollback + token 미소비 (실제 Pre-check 통과 후 Race 롤백 증명)
  it("Scenario 11: Concurrency conflict rolls back transaction and preserves unconsumed token", async () => {
    await seedBaseData("paused");
    const token = await obtainOfficialResumeToken(companyId, userId, "cred-test-id-1");

    const realWebauthnFactory = webauthnModule.webauthnService;
    let consumeCalledInTx = false;

    const factorySpy = vi.spyOn(webauthnModule, "webauthnService").mockImplementation((dbInstance) => {
      const realInstance = realWebauthnFactory(dbInstance);
      return {
        ...realInstance,
        consumeEmergencyResumeToken: async (input) => {
          if (input.tx) {
            consumeCalledInTx = true;
          }
          const result = await realInstance.consumeEmergencyResumeToken(input);
          // Concurrency injection right after token is consumed in transaction!
          await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
          return result;
        },
      };
    });

    try {
      const app = createApp();

      const [beforeCompany] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(beforeCompany?.status).toBe("paused");

      const res = await request(app)
        .post(`/api/companies/${companyId}/emergency-resume`)
        .send({ resumeToken: token });

      expect(consumeCalledInTx).toBe(true);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Company is no longer in paused state");
      expect(res.body.reason).toBe("company_not_paused");

      const [challenge] = await db
        .select()
        .from(webauthnChallenges)
        .where(eq(webauthnChallenges.challenge, token));
      expect(challenge?.consumedAt).toBeNull();

      // Verify token can still be consumed after rollback
      await db.update(companies).set({ status: "paused" }).where(eq(companies.id, companyId));
      const unspiedWebauthn = realWebauthnFactory(db);
      const retryResult = await unspiedWebauthn.consumeEmergencyResumeToken({
        token,
        companyId,
        userId,
      });
      expect(retryResult.valid).toBe(true);
    } finally {
      factorySpy.mockRestore();
    }
  });

  // Scenario 12: valid paired mobile resume 성공 + audit (공식 발급 토큰)
  it("Scenario 12: Valid paired mobile device resumes company to active with audit log", async () => {
    await seedBaseData("paused");
    const token = await obtainOfficialResumeToken(companyId, userId, "cred-test-id-1");

    const app = createApp({
      boardKeyScope: "approval_only",
      source: "board_key",
      userId,
    });
    const res = await request(app)
      .post(`/api/companies/${companyId}/emergency-resume`)
      .send({ resumeToken: token });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");

    const [persisted] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(persisted?.status).toBe("active");

    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(logs.some((l) => l.action === "company.emergency_resumed")).toBe(true);
  });

  // Scenario 13: approval_only scope 제한
  it("Scenario 13: APPROVAL_ONLY_SCOPE_ALLOWLIST allows emergency routes but denies generic PATCH", () => {
    const pauseAllowed = isApprovalOnlyBoardKeyRequestAllowed(
      "POST",
      `/api/companies/${companyId}/emergency-pause`,
    );
    const resumeAllowed = isApprovalOnlyBoardKeyRequestAllowed(
      "POST",
      `/api/companies/${companyId}/emergency-resume`,
    );
    const patchAllowed = isApprovalOnlyBoardKeyRequestAllowed(
      "PATCH",
      `/api/companies/${companyId}`,
    );

    expect(pauseAllowed).toBe(true);
    expect(resumeAllowed).toBe(true);
    expect(patchAllowed).toBe(false);
  });

  // Scenario 14: resume 후 scheduling 정상 재개 실제 런타임 검증
  it("Scenario 14: Successfully resumed company allows normal scheduling resumption", async () => {
    await seedBaseData("paused");
    const token = await obtainOfficialResumeToken(companyId, userId, "cred-test-id-1");
    const app = createApp();

    await request(app)
      .post(`/api/companies/${companyId}/emergency-resume`)
      .send({ resumeToken: token });

    const heartbeat = heartbeatService(db);
    const wakePromise = heartbeat.wakeup(agentId, {
      source: "manual",
      triggerDetail: "user",
      reason: "manual_user_retry",
      payload: {},
      requestedByActorType: "user",
      requestedByActorId: userId,
    });
    await expect(wakePromise).resolves.not.toThrow();
  });
});
