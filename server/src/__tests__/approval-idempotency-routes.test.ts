import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvalActionIdempotencyKeys,
  approvals,
  companies,
  createDb,
  issueApprovals,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";

const mockWakeup = vi.hoisted(() => vi.fn(async () => ({ id: "wake-run-1" }) as unknown));
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: mockWakeup,
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approval idempotency route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("approval idempotency HTTP contract (200/409/410, duplicate side-effect prevention)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-idempotency-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockWakeup.mockClear();
    await db.delete(approvalActionIdempotencyKeys);
    await db.delete(issueApprovals);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", approvalRoutes(db, {}));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAndAgent() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Co", issuePrefix: `T${Math.random().toString(36).slice(2, 6).toUpperCase()}` })
      .returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Agent" }).returning();
    companyId = company.id;
    agentId = agent.id;
    return { company, agent };
  }

  async function seedApproval(overrides: Partial<typeof approvals.$inferInsert> = {}) {
    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "request_board_approval",
        status: "pending",
        payload: { title: "test approval" },
        requestedByAgentId: agentId,
        ...overrides,
      })
      .returning();
    return approval;
  }

  it("approve with idempotencyKey succeeds (200), wakes the requester once, and replaying the same key returns the identical body without a second wakeup", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const app = await createApp();

    const first = await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .send({ decisionNote: "looks good", idempotencyKey: "mobile-tap-1" });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.effectiveStatus).toBe("approved");
    expect(mockWakeup).toHaveBeenCalledTimes(1);

    const second = await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .send({ decisionNote: "looks good", idempotencyKey: "mobile-tap-1" });

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    // The replay must not re-run the real approve logic at all — wakeup call
    // count stays at 1, not 2.
    expect(mockWakeup).toHaveBeenCalledTimes(1);
  });

  it("approve on an already-expired pending approval returns 410 with reason approval_expired (no idempotencyKey)", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval({ expiresAt: new Date(Date.now() - 60_000) });
    const app = await createApp();

    const res = await request(app).post(`/api/approvals/${approval.id}/approve`).send({});

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ reason: "approval_expired" });
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("approve on an already-expired pending approval with an idempotencyKey also returns 410, and the 410 itself is cached", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval({ expiresAt: new Date(Date.now() - 60_000) });
    const app = await createApp();

    const first = await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .send({ idempotencyKey: "expired-retry" });
    expect(first.status).toBe(410);

    const second = await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .send({ idempotencyKey: "expired-retry" });
    expect(second.status).toBe(410);
    expect(second.body).toEqual(first.body);
  });

  it("approve on an approval already resolved to a different status returns 409 already_resolved_conflict", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval({ status: "rejected" });
    const app = await createApp();

    const res = await request(app).post(`/api/approvals/${approval.id}/approve`).send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: "already_resolved_conflict", currentStatus: "rejected" });
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("reusing the same idempotencyKey with a different approval returns 409 idempotency_key_reused, without touching the second approval", async () => {
    await seedCompanyAndAgent();
    const approvalA = await seedApproval();
    const approvalB = await seedApproval();
    const app = await createApp();

    const first = await request(app)
      .post(`/api/approvals/${approvalA.id}/approve`)
      .send({ idempotencyKey: "shared-key" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/approvals/${approvalB.id}/approve`)
      .send({ idempotencyKey: "shared-key" });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ reason: "idempotency_key_reused" });

    const [rowB] = await db.select().from(approvals).where(eq(approvals.id, approvalB.id));
    expect(rowB.status).toBe("pending"); // untouched
  });

  it("two concurrent approve requests with the SAME idempotencyKey and body: only one side-effect run, both responses identical", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const app = await createApp();

    const [resA, resB] = await Promise.all([
      request(app).post(`/api/approvals/${approval.id}/approve`).send({ idempotencyKey: "concurrent-key" }),
      request(app).post(`/api/approvals/${approval.id}/approve`).send({ idempotencyKey: "concurrent-key" }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body).toEqual(resB.body);
    expect(mockWakeup).toHaveBeenCalledTimes(1);

    const idempotencyRows = await db.select().from(approvalActionIdempotencyKeys);
    expect(idempotencyRows).toHaveLength(1);
    expect(idempotencyRows[0].status).toBe("completed");
  });

  it("reject with idempotencyKey succeeds (200) and does not invoke wakeup", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const app = await createApp();

    const res = await request(app)
      .post(`/api/approvals/${approval.id}/reject`)
      .send({ decisionNote: "no", idempotencyKey: "reject-key-1" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.effectiveStatus).toBe("rejected");
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("request-revision with idempotencyKey succeeds (200) and a retry with the same key replays the same response", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const app = await createApp();

    const first = await request(app)
      .post(`/api/approvals/${approval.id}/request-revision`)
      .send({ decisionNote: "please clarify", idempotencyKey: "rev-key-1" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.effectiveStatus).toBe("revision_requested");

    const second = await request(app)
      .post(`/api/approvals/${approval.id}/request-revision`)
      .send({ decisionNote: "please clarify", idempotencyKey: "rev-key-1" });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it("approve without an idempotencyKey never touches the idempotency table at all", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const app = await createApp();

    const res = await request(app).post(`/api/approvals/${approval.id}/approve`).send({});
    expect(res.status).toBe(200);

    const rows = await db.select().from(approvalActionIdempotencyKeys);
    expect(rows).toHaveLength(0);
  });

  it("does not leak the idempotency table's internal fields (actorIdentity, requestFingerprint) in the HTTP response", async () => {
    await seedCompanyAndAgent();
    const approval = await seedApproval();
    const app = await createApp();

    const res = await request(app)
      .post(`/api/approvals/${approval.id}/approve`)
      .send({ idempotencyKey: "no-leak-key" });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("actorIdentity");
    expect(res.body).not.toHaveProperty("requestFingerprint");
  });
});
