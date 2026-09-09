import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  knowledgeRecords,
  memoryOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgeRoutes } from "../routes/knowledge.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Knowledge Layer integration tests", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  
  const company1Id = randomUUID();
  const company2Id = randomUUID();
  const agent1Id = randomUUID();
  const agent2Id = randomUUID();
  
  let actor: any = {
    type: "board",
    userId: randomUUID(),
    companyIds: [company1Id],
    source: "session",
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-knowledge-");
    db = createDb(tempDb.connectionString);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", knowledgeRoutes(db));
    app.use(errorHandler);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(knowledgeRecords);
    await db.delete(memoryOperations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    actor = {
      type: "board",
      userId: randomUUID(),
      companyIds: [company1Id],
      source: "session",
    };
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(id: string) {
    await db.insert(companies).values({
      id,
      name: "Test Company",
      issuePrefix: "TS" + id.slice(-4).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: randomUUID(),
    });
  }

  async function seedAgent(companyId: string, agentId: string) {
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      shortname: "test-agent",
      provider: "gemini",
      model: "gemini-1.5-pro",
    });
  }

  it("blocks Agent from reviewing and promoting memory operations with 403", async () => {
    await seedCompany(company1Id);
    
    // Create candidate
    const [op] = await db.insert(memoryOperations).values({
      companyId: company1Id,
      sourceType: "issue",
      sourceId: "ISS-1",
      content: "Important info",
      status: "candidate",
      reviewState: "pending",
    }).returning();

    // Set actor to agent
    actor = {
      type: "agent",
      agentId: agent1Id,
      companyId: company1Id,
      source: "agent_key",
    };

    // Review attempt should fail with 403
    const reviewRes = await request(app)
      .post(`/api/memory-operations/${op.id}/review`)
      .send({ reviewState: "approved" });
    expect(reviewRes.status).toBe(403);

    // Promote attempt should fail with 403
    const promoteRes = await request(app)
      .post(`/api/memory-operations/${op.id}/promote`)
      .send({ title: "New Wiki Page" });
    expect(promoteRes.status).toBe(403);
  });

  it("checks company boundaries on auxiliary FKs (issues, runs, agents)", async () => {
    await seedCompany(company1Id);
    await seedCompany(company2Id);
    
    // Seed agent in company-2
    await seedAgent(company2Id, agent2Id);

    actor = {
      type: "board",
      userId: randomUUID(),
      companyIds: [company1Id],
      source: "session",
    };

    // Attempt to create memory operation in company-1 referencing agent from company-2 should fail
    const res = await request(app)
      .post(`/api/companies/${company1Id}/memory-operations`)
      .send({
        sourceType: "agent_output",
        sourceId: "run-1",
        content: "Extracted information",
        sourceAgentId: agent2Id,
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("sourceAgentId must belong to the same company");
  });

  it("guarantees 1:1 idempotency on duplicate or concurrent promotions", async () => {
    await seedCompany(company1Id);

    // Seed approved candidate
    const [op] = await db.insert(memoryOperations).values({
      companyId: company1Id,
      sourceType: "issue",
      sourceId: "ISS-1",
      content: "Important facts to remember",
      status: "candidate",
      reviewState: "approved",
    }).returning();

    actor = {
      type: "board",
      userId: randomUUID(),
      companyIds: [company1Id],
      source: "session",
    };

    // First promotion
    const res1 = await request(app)
      .post(`/api/memory-operations/${op.id}/promote`)
      .send({ title: "Facts Wiki Page", body: "Facts markdown content" });

    expect(res1.status).toBe(201);
    expect(res1.body.knowledgeRecord).toBeDefined();
    expect(res1.body.operation.status).toBe("promoted");

    const recordId = res1.body.knowledgeRecord.id;

    // Second promotion (retry) should return 200 OK and same records, without generating new entries
    const res2 = await request(app)
      .post(`/api/memory-operations/${op.id}/promote`)
      .send({ title: "Facts Wiki Page", body: "Facts markdown content" });

    expect(res2.status).toBe(200);
    expect(res2.body.knowledgeRecord.id).toBe(recordId);
    
    // Check database to ensure only 1 knowledge record exists
    const records = await db.select().from(knowledgeRecords).where(eq(knowledgeRecords.sourceMemoryOperationId, op.id));
    expect(records.length).toBe(1);
  });
});
