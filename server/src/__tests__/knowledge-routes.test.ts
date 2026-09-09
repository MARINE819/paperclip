import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  heartbeatRuns,
  issues,
  knowledgeRecords,
  memoryOperations,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { knowledgeRoutes } from "../routes/knowledge.js";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

/**
 * Phase 2.1 integration coverage for the Memory Operation -> Knowledge
 * Record promotion flow. Runs against a real, isolated embedded Postgres
 * instance (see `helpers/embedded-postgres.ts`) so the DB-level 1:1
 * `knowledgeRecords.sourceMemoryOperationId` unique constraint, the
 * company-scoped FK checks, and the actual activity log writes are all
 * exercised for real — not mocked.
 */

type AgentActor = {
  type: "agent";
  agentId: string;
  companyId: string;
  runId: string | null;
  keyId: string | null;
  source: "agent_key";
};

function buildApp(db: Db, actor: BoardActor | AgentActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", knowledgeRoutes(db));
  app.use(errorHandler);
  return app;
}

async function resetFixtures(db: Db) {
  await db.delete(activityLog);
  await db.delete(knowledgeRecords);
  await db.delete(memoryOperations);
  await db.delete(heartbeatRuns);
  await db.delete(issues);
  await db.delete(agents);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}

describeEmbeddedPostgres("knowledge routes (memory operation -> knowledge record)", () => {
  const ctx = useEmbeddedPostgres("paperclip-knowledge-routes-", { resetEach: resetFixtures });

  async function seedScenario() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Knowledge Co");
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId: company.companyId,
      name: "Researcher",
      role: "engineer",
      status: "active",
    });
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId: company.companyId,
      title: "Investigate flaky retry loop",
    });
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.companyId,
      agentId,
    });
    const agentActor: AgentActor = {
      type: "agent",
      agentId,
      companyId: company.companyId,
      runId,
      keyId: null,
      source: "agent_key",
    };
    return { company, agentId, issueId, runId, agentActor };
  }

  async function createCandidate(
    db: Db,
    actor: BoardActor | AgentActor,
    companyId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const res = await request(buildApp(db, actor))
      .post(`/api/companies/${companyId}/memory-operations`)
      .send({
        sourceType: "issue",
        sourceId: "issue-source-ref",
        content: "## Root cause\nThe retry loop double-counted backoff.",
        title: "Flaky retry loop root cause",
        summary: "Backoff was applied twice.",
        ...overrides,
      });
    return res;
  }

  it("creates a memory operation as a candidate and logs the mutation", async () => {
    const { company, issueId, runId, agentId } = await seedScenario();
    const res = await createCandidate(ctx.db, company.actor, company.companyId, {
      sourceIssueId: issueId,
      sourceRunId: runId,
      sourceAgentId: agentId,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId: company.companyId,
      status: "candidate",
      reviewState: "pending",
      sourceIssueId: issueId,
      sourceRunId: runId,
      sourceAgentId: agentId,
    });

    const logged = await ctx.db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, company.companyId), eq(activityLog.action, "memory_operation.created")));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      entityType: "memory_operation",
      entityId: res.body.id,
      actorType: "user",
    });
  });

  it("allows an agent actor to create a memory operation in its own company", async () => {
    const { company, agentActor } = await seedScenario();
    const res = await createCandidate(ctx.db, agentActor, company.companyId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("candidate");
  });

  it("rejects a memory operation whose sourceIssueId belongs to another company", async () => {
    const { company, agentActor } = await seedScenario();
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");
    const otherIssueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: otherIssueId,
      companyId: otherCompany.companyId,
      title: "Someone else's issue",
    });

    const res = await createCandidate(ctx.db, agentActor, company.companyId, {
      sourceIssueId: otherIssueId,
    });

    expect(res.status).toBe(422);
  });

  it("rejects promotion of a candidate that has not been approved yet (409)", async () => {
    const { company } = await seedScenario();
    const created = await createCandidate(ctx.db, company.actor, company.companyId);

    const res = await request(buildApp(ctx.db, company.actor))
      .post(`/api/memory-operations/${created.body.id}/promote`)
      .send({});

    expect(res.status).toBe(409);
    const rows = await ctx.db.select().from(knowledgeRecords);
    expect(rows).toHaveLength(0);
  });

  it("lets the board approve a candidate", async () => {
    const { company } = await seedScenario();
    const created = await createCandidate(ctx.db, company.actor, company.companyId);

    const res = await request(buildApp(ctx.db, company.actor))
      .post(`/api/memory-operations/${created.body.id}/review`)
      .send({ reviewState: "approved" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reviewState: "approved", status: "candidate", reviewedByAgentId: null });

    const logged = await ctx.db.select().from(activityLog)
      .where(eq(activityLog.action, "memory_operation.reviewed"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ entityId: created.body.id, actorType: "user" });
  });

  it("promotes an approved candidate into a knowledge record with copied provenance", async () => {
    const { company, issueId, runId, agentId } = await seedScenario();
    const created = await createCandidate(ctx.db, company.actor, company.companyId, {
      sourceIssueId: issueId,
      sourceRunId: runId,
      sourceAgentId: agentId,
    });
    const app = buildApp(ctx.db, company.actor);
    await request(app).post(`/api/memory-operations/${created.body.id}/review`).send({ reviewState: "approved" });

    const res = await request(app).post(`/api/memory-operations/${created.body.id}/promote`).send({});

    expect(res.status).toBe(201);
    expect(res.body.operation).toMatchObject({ id: created.body.id, status: "promoted" });
    const record = res.body.knowledgeRecord;
    expect(record).toMatchObject({
      companyId: company.companyId,
      title: "Flaky retry loop root cause",
      summary: "Backoff was applied twice.",
      body: "## Root cause\nThe retry loop double-counted backoff.",
      sourceMemoryOperationId: created.body.id,
      sourceIssueId: issueId,
      sourceRunId: runId,
      sourceAgentId: agentId,
    });
    expect(record.metadata.provenance).toMatchObject({
      sourceType: "issue",
      sourceId: "issue-source-ref",
      memoryOperationId: created.body.id,
      sourceIssueId: issueId,
      sourceRunId: runId,
      sourceAgentId: agentId,
    });

    const logged = await ctx.db.select().from(activityLog)
      .where(eq(activityLog.action, "memory_operation.promoted"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ entityType: "knowledge_record", entityId: record.id });
  });

  it("does not create a second knowledge record when the same memory operation is promoted twice", async () => {
    const { company } = await seedScenario();
    const created = await createCandidate(ctx.db, company.actor, company.companyId);
    const app = buildApp(ctx.db, company.actor);
    await request(app).post(`/api/memory-operations/${created.body.id}/review`).send({ reviewState: "approved" });

    const first = await request(app).post(`/api/memory-operations/${created.body.id}/promote`).send({});
    const second = await request(app).post(`/api/memory-operations/${created.body.id}/promote`).send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.knowledgeRecord.id).toBe(first.body.knowledgeRecord.id);

    const rows = await ctx.db.select().from(knowledgeRecords)
      .where(eq(knowledgeRecords.sourceMemoryOperationId, created.body.id));
    expect(rows).toHaveLength(1);

    // The replayed promote must not write a second mutation activity log entry.
    const logged = await ctx.db.select().from(activityLog)
      .where(eq(activityLog.action, "memory_operation.promoted"));
    expect(logged).toHaveLength(1);
  });

  it("enforces the sourceMemoryOperationId unique constraint at the database level", async () => {
    const { company } = await seedScenario();
    const created = await createCandidate(ctx.db, company.actor, company.companyId);
    const app = buildApp(ctx.db, company.actor);
    await request(app).post(`/api/memory-operations/${created.body.id}/review`).send({ reviewState: "approved" });
    await request(app).post(`/api/memory-operations/${created.body.id}/promote`).send({});

    await expect(
      ctx.db.insert(knowledgeRecords).values({
        companyId: company.companyId,
        title: "Duplicate promotion attempt",
        body: "Should be rejected by the unique index.",
        sourceMemoryOperationId: created.body.id,
      }),
    ).rejects.toThrow();
  });

  it("returns 403 when an agent actor attempts to review a candidate", async () => {
    const { company, agentActor } = await seedScenario();
    const created = await createCandidate(ctx.db, company.actor, company.companyId);

    const res = await request(buildApp(ctx.db, agentActor))
      .post(`/api/memory-operations/${created.body.id}/review`)
      .send({ reviewState: "approved" });

    expect(res.status).toBe(403);
    const [unchanged] = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.id, created.body.id));
    expect(unchanged?.reviewState).toBe("pending");
  });

  it("returns 403 when an agent actor attempts to promote a candidate", async () => {
    const { company, agentActor } = await seedScenario();
    const created = await createCandidate(ctx.db, company.actor, company.companyId);
    await request(buildApp(ctx.db, company.actor))
      .post(`/api/memory-operations/${created.body.id}/review`)
      .send({ reviewState: "approved" });

    const res = await request(buildApp(ctx.db, agentActor))
      .post(`/api/memory-operations/${created.body.id}/promote`)
      .send({});

    expect(res.status).toBe(403);
    const rows = await ctx.db.select().from(knowledgeRecords);
    expect(rows).toHaveLength(0);
  });

  it("blocks another company's board actor from reading or acting on a memory operation", async () => {
    const { company } = await seedScenario();
    const created = await createCandidate(ctx.db, company.actor, company.companyId);
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");

    const getRes = await request(buildApp(ctx.db, otherCompany.actor))
      .get(`/api/companies/${company.companyId}/memory-operations`);
    // Cross-tenant company-id path access is rejected outright.
    expect(getRes.status).toBe(403);

    const reviewRes = await request(buildApp(ctx.db, otherCompany.actor))
      .post(`/api/memory-operations/${created.body.id}/review`)
      .send({ reviewState: "approved" });
    expect(reviewRes.status).toBe(404);

    const promoteRes = await request(buildApp(ctx.db, otherCompany.actor))
      .post(`/api/memory-operations/${created.body.id}/promote`)
      .send({});
    expect(promoteRes.status).toBe(404);

    const rows = await ctx.db.select().from(knowledgeRecords);
    expect(rows).toHaveLength(0);
  });
});
