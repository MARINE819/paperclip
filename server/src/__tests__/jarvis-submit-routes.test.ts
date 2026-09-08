import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  documentRevisions,
  documents,
  issueDocuments,
  issuePlanDecompositions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { issueRoutes } from "../routes/issues.js";

// The real heartbeat.wakeup() triggers actual, asynchronous, un-awaited
// execution (issue checkout, environment-lease acquisition, adapter
// execution) that outlives the HTTP request and races with this suite's own
// afterEach cleanup — see docs/investigations/jarvis-submit-route-test-isolation-review.md
// for the full analysis. Replacing only heartbeatService's wakeup method
// with a spy keeps every other export in this barrel real (including for
// the "existing route unchanged" labels-route test) while letting this
// suite assert precisely on how the route invokes wakeup. This spy is
// file-scoped: heartbeat.wakeup is also called from several other route
// handlers in issueRoutes(...) (not exercised by this file today), so a
// future test added here that exercises one of those routes should be aware
// this mock is active for the whole file.
const mockWakeup = vi.hoisted(() => vi.fn(async () => ({}) as unknown));
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
    `Skipping embedded Postgres JARVIS submit route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("POST /companies/:companyId/jarvis/submit", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-jarvis-submit-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockWakeup.mockClear();
    await db.delete(issuePlanDecompositions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(name = "Paperclip") {
    const [company] = await db
      .insert(companies)
      .values({
        name,
        issuePrefix: `J${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      })
      .returning();
    return company;
  }

  async function seedAgent(companyId: string, name: string, overrides: Record<string, unknown> = {}) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name, status: "idle", ...overrides })
      .returning();
    return agent;
  }

  function validPlanBody() {
    return {
      objective: "Fix the flaky login test",
      acceptanceCriteria: ["The flaky test passes 10/10 consecutive runs"],
      evidenceRequirements: ["targeted_test"],
      taskClass: "development",
      tasks: [
        {
          title: "Stabilize login test",
          instructions: "Investigate and fix the race condition in the login test.",
        },
      ],
    };
  }

  it("creates a parent Issue assigned to JARVIS and a child Issue assigned to the selected specialist for a valid Human submission", async () => {
    const company = await seedCompany();
    const jarvis = await seedAgent(company.id, "JARVIS");
    const specialist = await seedAgent(company.id, "Specialist");
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${company.id}/jarvis/submit`)
      .send({
        jarvisAgentId: jarvis.id,
        requestText: "Fix the flaky login test",
        plan: validPlanBody(),
      })
      .expect(201);

    expect(res.body.ok).toBe(true);
    expect(res.body.selectedAgentId).toBe(specialist.id);

    const [parentRow] = await db.select().from(issues).where(eq(issues.id, res.body.parentIssueId));
    expect(parentRow.assigneeAgentId).toBe(jarvis.id);
    expect(parentRow.status).toBe("todo");

    const [childRow] = await db.select().from(issues).where(eq(issues.id, res.body.childIssueId));
    expect(childRow.assigneeAgentId).toBe(specialist.id);
    expect(childRow.parentId).toBe(res.body.parentIssueId);
    expect(childRow.status).toBe("todo");
  });

  it("rejects an invalid request body (missing requestText) with a 400 validation error", async () => {
    const company = await seedCompany();
    const jarvis = await seedAgent(company.id, "JARVIS");
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${company.id}/jarvis/submit`)
      .send({ jarvisAgentId: jarvis.id, plan: validPlanBody() })
      .expect(400);

    expect(res.body.error).toBe("Validation error");
  });

  it("rejects submission from an agent actor and creates no Issue (Human-only enforcement)", async () => {
    const company = await seedCompany();
    const jarvis = await seedAgent(company.id, "JARVIS");
    const requester = await seedAgent(company.id, "Requesting Agent");
    const app = createApp();
    const token = createLocalAgentJwt(requester.id, company.id, "codex_local", "00000000-0000-0000-0000-000000000000");
    if (!token) throw new Error("expected a local agent JWT to be issued in this test environment");

    await request(app)
      .post(`/api/companies/${company.id}/jarvis/submit`)
      .set("Authorization", `Bearer ${token}`)
      .send({ jarvisAgentId: jarvis.id, requestText: "Fix the flaky login test", plan: validPlanBody() })
      .expect(403);

    const rows = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects an agent actor whose own company differs from the URL company (existing cross-company enforcement)", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const jarvisInB = await seedAgent(companyB.id, "JARVIS");
    const agentInA = await seedAgent(companyA.id, "Agent In A");
    const app = createApp();
    const token = createLocalAgentJwt(agentInA.id, companyA.id, "codex_local", "00000000-0000-0000-0000-000000000000");
    if (!token) throw new Error("expected a local agent JWT to be issued in this test environment");

    await request(app)
      .post(`/api/companies/${companyB.id}/jarvis/submit`)
      .set("Authorization", `Bearer ${token}`)
      .send({ jarvisAgentId: jarvisInB.id, requestText: "Fix the flaky login test", plan: validPlanBody() })
      .expect(403);
  });

  it("returns the same parentIssueId and reuses the same child on a repeated submission with the same idempotencyKey", async () => {
    const company = await seedCompany();
    const jarvis = await seedAgent(company.id, "JARVIS");
    await seedAgent(company.id, "Specialist");
    const app = createApp();
    const body = {
      jarvisAgentId: jarvis.id,
      requestText: "Fix the flaky login test",
      idempotencyKey: "test-idempotency-key-1",
      plan: validPlanBody(),
    };

    const first = await request(app).post(`/api/companies/${company.id}/jarvis/submit`).send(body).expect(201);
    const second = await request(app).post(`/api/companies/${company.id}/jarvis/submit`).send(body).expect(201);

    expect(second.body.parentIssueId).toBe(first.body.parentIssueId);
    expect(second.body.childIssueId).toBe(first.body.childIssueId);
    expect(second.body.parentIssueDeduplicated).toBe(true);

    const allIssues = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(allIssues).toHaveLength(2); // exactly one parent, one child — no duplicates from the repeated call
  });

  it("returns 422 with the already-created parentIssueId and creates no child or wakeup when no eligible specialist exists", async () => {
    const company = await seedCompany();
    const jarvis = await seedAgent(company.id, "JARVIS"); // the only agent in the company
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${company.id}/jarvis/submit`)
      .send({ jarvisAgentId: jarvis.id, requestText: "Fix the flaky login test", plan: validPlanBody() })
      .expect(422);

    expect(res.body.reason).toBe("no_eligible_specialist");
    expect(typeof res.body.parentIssueId).toBe("string");

    const childRows = await db.select().from(issues).where(eq(issues.parentId, res.body.parentIssueId));
    expect(childRows).toHaveLength(0);

    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("creates a queued wakeup request for the selected specialist with canonical identifiers on success", async () => {
    const company = await seedCompany();
    const jarvis = await seedAgent(company.id, "JARVIS");
    const specialist = await seedAgent(company.id, "Specialist");
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${company.id}/jarvis/submit`)
      .send({ jarvisAgentId: jarvis.id, requestText: "Fix the flaky login test", plan: validPlanBody() })
      .expect(201);

    expect(mockWakeup).toHaveBeenCalledTimes(1);
    expect(mockWakeup).toHaveBeenCalledWith(
      specialist.id,
      expect.objectContaining({
        source: "assignment",
        payload: expect.objectContaining({ issueId: res.body.childIssueId }),
      }),
    );
  });

  it("never marks the parent or child Issue done and never creates an approval on a successful submission", async () => {
    const company = await seedCompany();
    const jarvis = await seedAgent(company.id, "JARVIS");
    await seedAgent(company.id, "Specialist");
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${company.id}/jarvis/submit`)
      .send({ jarvisAgentId: jarvis.id, requestText: "Fix the flaky login test", plan: validPlanBody() })
      .expect(201);

    const rows = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(rows.every((row) => row.status !== "done")).toBe(true);

    const approvalRows = await db.select().from(approvals).where(eq(approvals.companyId, company.id));
    expect(approvalRows).toHaveLength(0);
  });

  it("leaves every existing issues.ts route behavior unchanged (labels route still works)", async () => {
    const company = await seedCompany();
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${company.id}/labels`)
      .send({ name: "Existing route smoke test", color: "#123456" })
      .expect(201);

    expect(res.body.name).toBe("Existing route smoke test");
  });
});
