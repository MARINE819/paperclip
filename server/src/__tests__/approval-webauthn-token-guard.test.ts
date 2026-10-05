import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isApprovalOnlyBoardKeyRequestAllowed } from "../routes/authz.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

const mockConsumeApprovalToken = vi.hoisted(() => vi.fn());
const mockIssueApprovalToken = vi.hoisted(() => vi.fn());

const mockCheckApprovalIdempotency = vi.hoisted(() => vi.fn());
const mockClaimApprovalIdempotency = vi.hoisted(() => vi.fn());
const mockCompleteApprovalIdempotency = vi.hoisted(() => vi.fn());

let transactionRollbackCount = 0;
let transactionCommitCount = 0;

function createRouteDb() {
  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
    transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => {
      try {
        const result = await cb(db);
        transactionCommitCount++;
        return result;
      } catch (err) {
        transactionRollbackCount++;
        throw err;
      }
    }),
  };
  return db;
}

function registerMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/webauthn-service.js", () => ({
    webauthnService: () => ({
      consumeApprovalToken: mockConsumeApprovalToken,
      issueApprovalToken: mockIssueApprovalToken,
    }),
  }));

  vi.doMock("../services/approval-lifecycle.js", async (importOriginal) => {
    const actual = (await importOriginal()) as any;
    return {
      ...actual,
      checkApprovalIdempotency: mockCheckApprovalIdempotency,
      claimApprovalIdempotency: mockClaimApprovalIdempotency,
      completeApprovalIdempotency: mockCompleteApprovalIdempotency,
    };
  });
}

async function createApp(actorOverrides: Record<string, unknown> = {}, routeDb = createRouteDb()) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      boardKeyScope: null,
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes(routeDb));
  app.use(errorHandler);
  return app;
}

describe("approval WebAuthn token guard & mobile bridge (14 scenarios)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/webauthn-service.js");
    vi.doUnmock("../services/approval-lifecycle.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerMocks();
    vi.clearAllMocks();

    transactionRollbackCount = 0;
    transactionCommitCount = 0;

    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: true,
      outcome: "applied",
    });

    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });

    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);

    mockConsumeApprovalToken.mockResolvedValue({
      valid: true,
      row: {
        id: "chal-1",
        challenge: "valid-token",
        purpose: "approval_token",
        bindingId: "approval-1",
        companyId: "company-1",
        userId: "user-1",
        consumedAt: new Date(),
      },
    });

    mockCheckApprovalIdempotency.mockResolvedValue({ kind: "proceed" });
    mockClaimApprovalIdempotency.mockResolvedValue({ kind: "won", claimId: "claim-1" });
    mockCompleteApprovalIdempotency.mockResolvedValue(undefined);
  });

  // 1. Desktop session user approves without token -> success (200)
  it("1. desktop_session_approve_no_token_success", async () => {
    const app = await createApp({ source: "session", boardKeyScope: null });
    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(mockConsumeApprovalToken).not.toHaveBeenCalled();
    expect(mockApprovalService.approve).toHaveBeenCalledWith("approval-1", "user-1", undefined);
  });

  // 2. Desktop local_implicit user approves without token -> success (200)
  it("2. desktop_local_implicit_approve_no_token_success", async () => {
    const app = await createApp({ source: "local_implicit", boardKeyScope: null });
    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(mockConsumeApprovalToken).not.toHaveBeenCalled();
  });

  // 3. Mobile approval_only missing token -> 401 approval_token_required
  it("3. mobile_approval_only_missing_token_401", async () => {
    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });
    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "WebAuthn approval token required for mobile approval",
      reason: "approval_token_required",
    });
    expect(mockConsumeApprovalToken).not.toHaveBeenCalled();
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  // 4. Mobile approval_only invalid token -> 401 approval_token_invalid
  it("4. mobile_approval_only_invalid_token_401", async () => {
    mockConsumeApprovalToken.mockResolvedValueOnce({
      valid: false,
      status: 401,
      reason: "approval_token_invalid",
      error: "Invalid WebAuthn approval token",
    });

    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });
    const res = await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ approvalToken: "fake-token" });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "Invalid WebAuthn approval token",
      reason: "approval_token_invalid",
    });
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  // 5. Mobile approval_only expired token -> 410 approval_token_expired
  it("5. mobile_approval_only_expired_token_410", async () => {
    mockConsumeApprovalToken.mockResolvedValueOnce({
      valid: false,
      status: 410,
      reason: "approval_token_expired",
      error: "Approval token has expired",
    });

    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });
    const res = await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ approvalToken: "expired-token" });

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({
      error: "Approval token has expired",
      reason: "approval_token_expired",
    });
  });

  // 6. Mobile approval_only already consumed token -> 409 approval_token_already_consumed
  it("6. mobile_approval_only_already_consumed_token_409", async () => {
    mockConsumeApprovalToken.mockResolvedValueOnce({
      valid: false,
      status: 409,
      reason: "approval_token_already_consumed",
      error: "Approval token has already been consumed",
    });

    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });
    const res = await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ approvalToken: "used-token" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "Approval token has already been consumed",
      reason: "approval_token_already_consumed",
    });
  });

  // 7. Mobile approval_only binding mismatch (wrong approval ID) -> 403
  it("7. mobile_approval_only_binding_mismatch_approval_id_403", async () => {
    mockConsumeApprovalToken.mockResolvedValueOnce({
      valid: false,
      status: 403,
      reason: "approval_token_binding_mismatch",
      error: "Approval token binding mismatch",
    });

    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });
    const res = await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ approvalToken: "mismatched-approval-token" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "Approval token binding mismatch",
      reason: "approval_token_binding_mismatch",
    });
  });

  // 8. Mobile approval_only binding mismatch (wrong company ID) -> 403
  it("8. mobile_approval_only_binding_mismatch_company_id_403", async () => {
    mockConsumeApprovalToken.mockResolvedValueOnce({
      valid: false,
      status: 403,
      reason: "approval_token_binding_mismatch",
      error: "Approval token binding mismatch",
    });

    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });
    const res = await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ approvalToken: "mismatched-company-token" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      reason: "approval_token_binding_mismatch",
    });
  });

  // 9. Mobile approval_only binding mismatch (wrong user ID) -> 403
  it("9. mobile_approval_only_binding_mismatch_user_id_403", async () => {
    mockConsumeApprovalToken.mockResolvedValueOnce({
      valid: false,
      status: 403,
      reason: "approval_token_binding_mismatch",
      error: "Approval token binding mismatch",
    });

    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });
    const res = await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ approvalToken: "mismatched-user-token" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      reason: "approval_token_binding_mismatch",
    });
  });

  // 10. Mobile idempotency replay without token -> cached 200 without token re-consumption
  it("10. mobile_idempotency_key_replay_no_token_reconsumption_200", async () => {
    mockCheckApprovalIdempotency.mockResolvedValueOnce({
      kind: "replay",
      httpStatus: 200,
      body: { id: "approval-1", status: "approved", replayCached: true },
    });

    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });
    // Note: NO approvalToken in request body!
    const res = await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ idempotencyKey: "replay-key-1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "approval-1", status: "approved", replayCached: true });
    // Proves token was neither required nor consumed on replay!
    expect(mockConsumeApprovalToken).not.toHaveBeenCalled();
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  // 11. Mobile concurrent claim loser does NOT burn token
  it("11. mobile_idempotency_key_concurrent_claim_loser_no_token_burn", async () => {
    mockCheckApprovalIdempotency.mockResolvedValueOnce({ kind: "proceed" });
    mockClaimApprovalIdempotency.mockResolvedValueOnce({
      kind: "lost_replay",
      httpStatus: 200,
      body: { id: "approval-1", status: "approved", concurrentCached: true },
    });

    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });
    const res = await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ idempotencyKey: "concurrent-key-1", approvalToken: "valid-token" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "approval-1", status: "approved", concurrentCached: true });
    // Claim loser must not consume token!
    expect(mockConsumeApprovalToken).not.toHaveBeenCalled();
  });

  // 12. Different idempotencyKey + same approvalToken race -> exactly 1 winner, 1 loser (409)
  it("12. mobile_concurrent_different_idempotency_keys_same_token_race", async () => {
    let callCount = 0;
    mockConsumeApprovalToken.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          valid: true,
          row: { id: "chal-1", consumedAt: new Date() },
        };
      }
      return {
        valid: false,
        status: 409,
        reason: "approval_token_already_consumed",
        error: "Approval token has already been consumed",
      };
    });

    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });

    const [res1, res2] = await Promise.all([
      request(app).post("/api/approvals/approval-1/approve").send({
        idempotencyKey: "key-A",
        approvalToken: "same-token-123",
      }),
      request(app).post("/api/approvals/approval-1/approve").send({
        idempotencyKey: "key-B",
        approvalToken: "same-token-123",
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Exactly 1 approval was applied
    expect(mockApprovalService.approve).toHaveBeenCalledTimes(1);
    // Exactly 1 approval.approved activity log entry
    const approvalLogs = mockLogActivity.mock.calls.filter(
      ([, entry]: [any, any]) => entry?.action === "approval.approved",
    );
    expect(approvalLogs).toHaveLength(1);
  });

  // 13. Allowlist permits WebAuthn and Web Push routes for approval_only key
  it("13. mobile_allowlist_permits_webauthn_and_push_routes", () => {
    // WebAuthn
    expect(isApprovalOnlyBoardKeyRequestAllowed("POST", "/api/companies/c1/webauthn/register/options")).toBe(true);
    expect(isApprovalOnlyBoardKeyRequestAllowed("POST", "/api/companies/c1/webauthn/register/verify")).toBe(true);
    expect(isApprovalOnlyBoardKeyRequestAllowed("POST", "/api/companies/c1/webauthn/authenticate/options")).toBe(true);
    expect(isApprovalOnlyBoardKeyRequestAllowed("POST", "/api/companies/c1/webauthn/authenticate/verify")).toBe(true);
    expect(isApprovalOnlyBoardKeyRequestAllowed("GET", "/api/companies/c1/webauthn/credentials")).toBe(true);
    expect(isApprovalOnlyBoardKeyRequestAllowed("DELETE", "/api/companies/c1/webauthn/credentials/cred-1")).toBe(true);

    // Web Push
    expect(isApprovalOnlyBoardKeyRequestAllowed("GET", "/api/push/public-key")).toBe(true);
    expect(isApprovalOnlyBoardKeyRequestAllowed("POST", "/api/companies/c1/push/subscribe")).toBe(true);
    expect(isApprovalOnlyBoardKeyRequestAllowed("POST", "/api/companies/c1/push/unsubscribe")).toBe(true);

    // Standard approval routes remain allowed
    expect(isApprovalOnlyBoardKeyRequestAllowed("POST", "/api/approvals/app-1/approve")).toBe(true);
    expect(isApprovalOnlyBoardKeyRequestAllowed("POST", "/api/approvals/app-1/reject")).toBe(true);
    expect(isApprovalOnlyBoardKeyRequestAllowed("GET", "/api/approvals/app-1")).toBe(true);

    // Unauthorized route must be denied
    expect(isApprovalOnlyBoardKeyRequestAllowed("POST", "/api/companies/c1/agents")).toBe(false);
    expect(isApprovalOnlyBoardKeyRequestAllowed("GET", "/api/actor")).toBe(false);
  });

  // 14. Mobile no-idempotency token rollback on approve failure (no token burn)
  it("14. mobile_no_idempotency_token_rollback", async () => {
    mockApprovalService.approve.mockResolvedValueOnce({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "expired",
        expiresAt: new Date(Date.now() - 1000),
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
      outcome: "expired",
    });

    const app = await createApp({ source: "board_key", boardKeyScope: "approval_only" });
    const res = await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ approvalToken: "valid-token-will-rollback" });

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({
      reason: "approval_expired",
      error: "This approval has expired and can no longer be resolved",
    });

    // Proves transaction was rolled back!
    expect(transactionRollbackCount).toBe(1);
    expect(transactionCommitCount).toBe(0);

    // Side effects were NOT run
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});
