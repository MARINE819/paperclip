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
  issueWorkProducts,
  knowledgeRecords,
  memoryOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgeRoutes } from "../routes/knowledge.js";
import { knowledgeService } from "../services/knowledge.js";
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
    await db.delete(issueWorkProducts);
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

  it("[F-07] a newly promoted knowledge record is created with externalSyncState='pending', never NULL", async () => {
    await seedCompany(company1Id);
    const [op] = await db.insert(memoryOperations).values({
      companyId: company1Id,
      sourceType: "issue",
      sourceId: "ISS-2",
      content: "Facts to auto-save",
      status: "candidate",
      reviewState: "approved",
    }).returning();

    actor = { type: "board", userId: randomUUID(), companyIds: [company1Id], source: "session" };

    const res = await request(app)
      .post(`/api/memory-operations/${op.id}/promote`)
      .send({ title: "Auto Save Wiki Page", body: "Facts markdown content" });

    expect(res.status).toBe(201);
    expect(res.body.knowledgeRecord.externalSyncState).toBe("pending");

    const [row] = await db.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, res.body.knowledgeRecord.id));
    expect(row.externalSyncState).toBe("pending");
  });

  describe("listKnowledgeRecords search and retrieval", () => {
    it("searches records by title, summary, or body with case-insensitive matching and enforces company isolation", async () => {
      await seedCompany(company1Id);
      await seedCompany(company2Id);
      const svc = knowledgeService(db);

      await db.insert(knowledgeRecords).values([
        {
          id: randomUUID(),
          companyId: company1Id,
          title: "System Architecture Standards",
          summary: "Guidelines for distributed services",
          body: "Always use idempotency keys on mutating routes.",
          status: "active",
        },
        {
          id: randomUUID(),
          companyId: company1Id,
          title: "Database Indexing Patterns",
          summary: "Trigram indexing conventions",
          body: "PostgreSQL gin_trgm_ops speeds up substring search.",
          status: "active",
        },
        {
          id: randomUUID(),
          companyId: company1Id,
          title: "Release Playbook",
          summary: "Checklist for deploying safely",
          body: "Review telemetry before and after traffic migration.",
          status: "active",
        },
        // Company 2 record with same keyword
        {
          id: randomUUID(),
          companyId: company2Id,
          title: "Secret Architecture Guide",
          summary: "Internal to company 2",
          body: "Confidential architecture specs.",
          status: "active",
        },
      ]);

      // 1. Without q: returns all 3 records for company1
      const allCompany1 = await svc.listKnowledgeRecords(company1Id);
      expect(allCompany1).toHaveLength(3);

      // 2. Search by title keyword (case-insensitive)
      const titleMatches = await svc.listKnowledgeRecords(company1Id, { q: "architecture" });
      expect(titleMatches).toHaveLength(1);
      expect(titleMatches[0]!.title).toBe("System Architecture Standards");

      // 3. Search by summary keyword
      const summaryMatches = await svc.listKnowledgeRecords(company1Id, { q: "Trigram indexing" });
      expect(summaryMatches).toHaveLength(1);
      expect(summaryMatches[0]!.title).toBe("Database Indexing Patterns");

      // 4. Search by body keyword
      const bodyMatches = await svc.listKnowledgeRecords(company1Id, { q: "telemetry" });
      expect(bodyMatches).toHaveLength(1);
      expect(bodyMatches[0]!.title).toBe("Release Playbook");

      // 5. No match returns empty array
      const noMatches = await svc.listKnowledgeRecords(company1Id, { q: "nonexistent-term-xyz" });
      expect(noMatches).toHaveLength(0);

      // 6. Company isolation: searching "architecture" in company1 never returns company2 records
      const c1Results = await svc.listKnowledgeRecords(company1Id, { q: "architecture" });
      expect(c1Results.every((r) => r.companyId === company1Id)).toBe(true);

      const c2Results = await svc.listKnowledgeRecords(company2Id, { q: "architecture" });
      expect(c2Results).toHaveLength(1);
      expect(c2Results[0]!.title).toBe("Secret Architecture Guide");
      expect(c2Results[0]!.companyId).toBe(company2Id);

      // 7. Limit behavior
      const limited = await svc.listKnowledgeRecords(company1Id, { limit: 2 });
      expect(limited).toHaveLength(2);

      // 8. Empty string / whitespace q behaves like no q
      const emptyQ = await svc.listKnowledgeRecords(company1Id, { q: "   " });
      expect(emptyQ).toHaveLength(3);
    });

    it("M2-03-B03: rejected is excluded by default, verified ranks ahead of unverified, and explicit filters/includeRejected override the defaults", async () => {
      await seedCompany(company1Id);
      await seedCompany(company2Id);
      const svc = knowledgeService(db);

      // Older verified record and a newer unverified one -- recency alone
      // would put the unverified one first; verification rank must win.
      const olderVerified = new Date("2026-01-01T00:00:00Z");
      const newerUnverified = new Date("2026-02-01T00:00:00Z");
      const [verifiedRow] = await db.insert(knowledgeRecords).values({
        companyId: company1Id,
        title: "Verified Older",
        body: "body",
        verificationStatus: "verified",
        knowledgeType: "FACT",
        createdAt: olderVerified,
      }).returning();
      const [unverifiedRow] = await db.insert(knowledgeRecords).values({
        companyId: company1Id,
        title: "Unverified Newer",
        body: "body",
        verificationStatus: "unverified",
        knowledgeType: "OPINION",
        createdAt: newerUnverified,
      }).returning();
      const [rejectedRow] = await db.insert(knowledgeRecords).values({
        companyId: company1Id,
        title: "Rejected Record",
        body: "body",
        verificationStatus: "rejected",
        createdAt: newerUnverified,
      }).returning();
      // Company isolation control row: same title keyword, different company.
      await db.insert(knowledgeRecords).values({
        companyId: company2Id,
        title: "Verified Older",
        body: "body",
        verificationStatus: "verified",
      });

      // 1. Default: rejected excluded, verified ranks ahead of unverified
      //    despite being older.
      const defaultList = await svc.listKnowledgeRecords(company1Id);
      expect(defaultList.map((r) => r.id)).toEqual([verifiedRow!.id, unverifiedRow!.id]);

      // 2. includeRejected=true surfaces it, still ranked last.
      const withRejected = await svc.listKnowledgeRecords(company1Id, { includeRejected: true });
      expect(withRejected.map((r) => r.id)).toEqual([verifiedRow!.id, unverifiedRow!.id, rejectedRow!.id]);

      // 3. Explicit verificationStatus: "rejected" filter works even
      //    WITHOUT includeRejected -- deliberate intent overrides the default.
      const onlyRejected = await svc.listKnowledgeRecords(company1Id, { verificationStatus: "rejected" });
      expect(onlyRejected.map((r) => r.id)).toEqual([rejectedRow!.id]);

      // 4. verificationStatus filter narrows to exactly that state.
      const onlyVerified = await svc.listKnowledgeRecords(company1Id, { verificationStatus: "verified" });
      expect(onlyVerified.map((r) => r.id)).toEqual([verifiedRow!.id]);

      // 5. knowledgeType filter.
      const onlyFact = await svc.listKnowledgeRecords(company1Id, { knowledgeType: "FACT" });
      expect(onlyFact.map((r) => r.id)).toEqual([verifiedRow!.id]);

      // 6. Company isolation preserved under the new filters too.
      const company2Default = await svc.listKnowledgeRecords(company2Id);
      expect(company2Default).toHaveLength(1);
      expect(company2Default[0]!.companyId).toBe(company2Id);
    });
  });

  describe("M2-03-B01 Knowledge Revision & Confidence Hardening", () => {
    it("promotion creates revisionNumber=1, a matching revision row, and carries confidence through unchanged", async () => {
      await seedCompany(company1Id);
      const [op] = await db.insert(memoryOperations).values({
        companyId: company1Id,
        sourceType: "issue",
        sourceId: "ISS-B01-1",
        content: "Confident fact",
        confidence: 0.82,
        status: "candidate",
        reviewState: "approved",
      }).returning();

      const svc = knowledgeService(db);
      const { knowledgeRecord } = await svc.promoteMemoryOperation(op.id, {
        title: "B01 Wiki Page",
        body: "Confident fact body",
      });

      expect(knowledgeRecord.revisionNumber).toBe(1);
      expect(knowledgeRecord.confidence).toBe(0.82);
      expect(knowledgeRecord.latestRevisionId).toBeTruthy();

      const revisions = await svc.listKnowledgeRecordRevisions(knowledgeRecord.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.revisionNumber).toBe(1);
      expect(revisions[0]!.confidence).toBe(0.82);
      expect(revisions[0]!.id).toBe(knowledgeRecord.latestRevisionId);
    });

    it("promotion with a null-confidence candidate keeps the knowledge record's confidence null, never defaulted to 0", async () => {
      await seedCompany(company1Id);
      const [op] = await db.insert(memoryOperations).values({
        companyId: company1Id,
        sourceType: "issue",
        sourceId: "ISS-B01-2",
        content: "No confidence recorded",
        status: "candidate",
        reviewState: "approved",
      }).returning();

      const svc = knowledgeService(db);
      const { knowledgeRecord } = await svc.promoteMemoryOperation(op.id, {
        title: "No Confidence Wiki Page",
        body: "Body text",
      });

      expect(knowledgeRecord.confidence).toBeNull();
      const revisions = await svc.listKnowledgeRecordRevisions(knowledgeRecord.id);
      expect(revisions[0]!.confidence).toBeNull();
    });

    it("updateKnowledgeRecord increments the revision exactly once, preserves the prior revision, and carries confidence forward unchanged when not explicitly passed", async () => {
      await seedCompany(company1Id);
      const [op] = await db.insert(memoryOperations).values({
        companyId: company1Id,
        sourceType: "issue",
        sourceId: "ISS-B01-3",
        content: "Original body",
        confidence: 0.5,
        status: "candidate",
        reviewState: "approved",
      }).returning();

      const svc = knowledgeService(db);
      const { knowledgeRecord: v1 } = await svc.promoteMemoryOperation(op.id, {
        title: "Versioned Wiki Page",
        body: "Original body",
      });
      expect(v1.revisionNumber).toBe(1);

      const { knowledgeRecord: v2, revision: rev2 } = await svc.updateKnowledgeRecord(v1.id, {
        baseRevisionId: v1.latestRevisionId!,
        body: "Updated body text",
        changeSummary: "Clarified wording.",
      });

      expect(v2.revisionNumber).toBe(2);
      expect(v2.body).toBe("Updated body text");
      // Confidence was NOT passed in this update -> must carry forward unchanged,
      // never silently increased merely because the record was re-saved.
      expect(v2.confidence).toBe(0.5);
      expect(rev2.revisionNumber).toBe(2);
      expect(rev2.confidence).toBe(0.5);

      // Full history remains reconstructable: both revisions still exist.
      const revisions = await svc.listKnowledgeRecordRevisions(v1.id);
      expect(revisions).toHaveLength(2);
      expect(revisions.map((r) => r.revisionNumber).sort()).toEqual([1, 2]);
      const firstRevision = revisions.find((r) => r.revisionNumber === 1)!;
      expect(firstRevision.body).toBe("Original body");
    });

    it("updateKnowledgeRecord rejects a stale baseRevisionId and creates no orphan revision row", async () => {
      await seedCompany(company1Id);
      const [op] = await db.insert(memoryOperations).values({
        companyId: company1Id,
        sourceType: "issue",
        sourceId: "ISS-B01-4",
        content: "Race body",
        confidence: 0.3,
        status: "candidate",
        reviewState: "approved",
      }).returning();

      const svc = knowledgeService(db);
      const { knowledgeRecord: v1 } = await svc.promoteMemoryOperation(op.id, {
        title: "Race Wiki Page",
        body: "Race body",
      });

      // First update succeeds and advances to revision 2.
      await svc.updateKnowledgeRecord(v1.id, {
        baseRevisionId: v1.latestRevisionId!,
        body: "First update wins",
      });

      // Second update still targets the now-stale revision 1 id -> must be rejected.
      await expect(
        svc.updateKnowledgeRecord(v1.id, {
          baseRevisionId: v1.latestRevisionId!,
          body: "Second update loses",
        }),
      ).rejects.toMatchObject({ status: 409 });

      // Exactly 2 revisions exist (1 and 2) -- the rejected call created no orphan revision 3.
      const revisions = await svc.listKnowledgeRecordRevisions(v1.id);
      expect(revisions).toHaveLength(2);
      expect(revisions.map((r) => r.revisionNumber).sort()).toEqual([1, 2]);
    });

    it("repeated promotion of multiple independent candidates into separate knowledge records never auto-increases any single record's confidence", async () => {
      await seedCompany(company1Id);
      const [opA] = await db.insert(memoryOperations).values({
        companyId: company1Id,
        sourceType: "issue",
        sourceId: "ISS-B01-5A",
        content: "Independent evidence A",
        confidence: 0.4,
        status: "candidate",
        reviewState: "approved",
      }).returning();

      const svc = knowledgeService(db);
      const { knowledgeRecord: recordA } = await svc.promoteMemoryOperation(opA.id, {
        title: "Evidence A Wiki Page",
        body: "Independent evidence A",
      });
      expect(recordA.confidence).toBe(0.4);

      // Re-saving the SAME record twice with no new confidence value must never
      // raise it on its own -- repetition is not new independent evidence.
      const { knowledgeRecord: afterFirstResave } = await svc.updateKnowledgeRecord(recordA.id, {
        baseRevisionId: recordA.latestRevisionId!,
        changeSummary: "Cosmetic re-save, no new evidence.",
      });
      expect(afterFirstResave.confidence).toBe(0.4);

      const { knowledgeRecord: afterSecondResave } = await svc.updateKnowledgeRecord(recordA.id, {
        baseRevisionId: afterFirstResave.latestRevisionId!,
        changeSummary: "Another cosmetic re-save, still no new evidence.",
      });
      expect(afterSecondResave.confidence).toBe(0.4);
      expect(afterSecondResave.revisionNumber).toBe(3);
    });
  });

  describe("M2-03-B02 Knowledge Verification Status & Type Taxonomy", () => {
    it("promotion sets verificationStatus='verified', since it already requires reviewState='approved'", async () => {
      await seedCompany(company1Id);
      const [op] = await db.insert(memoryOperations).values({
        companyId: company1Id,
        sourceType: "issue",
        sourceId: "ISS-B02-1",
        content: "Verified fact",
        status: "candidate",
        reviewState: "approved",
      }).returning();

      const svc = knowledgeService(db);
      const { knowledgeRecord } = await svc.promoteMemoryOperation(op.id, {
        title: "B02 Wiki Page",
        body: "Verified fact body",
      });

      expect(knowledgeRecord.verificationStatus).toBe("verified");
    });

    it("a direct insert with an invalid knowledgeType is rejected by the DB CHECK constraint", async () => {
      await seedCompany(company1Id);
      await expect(
        db.insert(knowledgeRecords).values({
          companyId: company1Id,
          knowledgeType: "NOT_A_REAL_TYPE",
          title: "Invalid Type Page",
          body: "Body text",
        }),
      ).rejects.toThrow();
    });

    it("NULL knowledgeType remains valid (backward compatibility for every existing and most new rows)", async () => {
      await seedCompany(company1Id);
      const [row] = await db.insert(knowledgeRecords).values({
        companyId: company1Id,
        knowledgeType: null,
        title: "Untyped Page",
        body: "Body text",
      }).returning();
      expect(row!.knowledgeType).toBeNull();
    });

    it("each of the four constrained knowledgeType values is accepted", async () => {
      await seedCompany(company1Id);
      for (const kt of ["FACT", "OPINION", "ANALYSIS", "DECISION"] as const) {
        const [row] = await db.insert(knowledgeRecords).values({
          companyId: company1Id,
          knowledgeType: kt,
          title: `${kt} Page`,
          body: "Body text",
        }).returning();
        expect(row!.knowledgeType).toBe(kt);
      }
    });

    it("a direct insert with an invalid verificationStatus is rejected by the DB CHECK constraint", async () => {
      await seedCompany(company1Id);
      await expect(
        db.insert(knowledgeRecords).values({
          companyId: company1Id,
          verificationStatus: "NOT_A_REAL_STATUS" as never,
          title: "Invalid Status Page",
          body: "Body text",
        }),
      ).rejects.toThrow();
    });

    it("a row written without an explicit verificationStatus defaults to 'unverified'", async () => {
      await seedCompany(company1Id);
      const [row] = await db.insert(knowledgeRecords).values({
        companyId: company1Id,
        title: "Default Status Page",
        body: "Body text",
      }).returning();
      expect(row!.verificationStatus).toBe("unverified");
    });
  });

  describe("M2-03-B07 getKnowledgeUsageEffectiveness", () => {
    async function seedRunWithIssueAndWorkProduct(
      companyId: string,
      agentId: string,
      opts: { issueStatus?: string; healthStatus?: "unknown" | "healthy" | "unhealthy"; costUsd?: string; actualExecutor?: string } = {},
    ) {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Fix the thing",
        identifier: `NEX-${issueId.slice(0, 8)}`,
        status: opts.issueStatus ?? "done",
      });
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        resultJson: { total_cost_usd: opts.costUsd ?? "0.12", actualExecutor: opts.actualExecutor ?? "codex_local" },
      });
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        createdByRunId: runId,
        type: "pull_request",
        provider: "github",
        title: "PR for the fix",
        status: "active",
        healthStatus: opts.healthStatus ?? "healthy",
      });
      return { issueId, runId };
    }

    it("links a knowledge record's usage to the exact run, work product, outcome, cost, and executor", async () => {
      await seedCompany(company1Id);
      await seedAgent(company1Id, agent1Id);
      const [record] = await db.insert(knowledgeRecords).values({
        companyId: company1Id,
        title: "Reusable fix pattern",
        body: "body",
        verificationStatus: "verified",
      }).returning();
      const { issueId, runId } = await seedRunWithIssueAndWorkProduct(company1Id, agent1Id, {
        issueStatus: "done",
        healthStatus: "healthy",
        costUsd: "0.42",
        actualExecutor: "claude_local",
      });
      await db.insert(activityLog).values({
        companyId: company1Id,
        actorType: "system",
        actorId: "heartbeat_context_build",
        entityType: "knowledge_record",
        entityId: record!.id,
        agentId: agent1Id,
        runId,
        action: "knowledge_record.injected_into_context",
      });

      const svc = knowledgeService(db);
      const entries = await svc.getKnowledgeUsageEffectiveness(company1Id, record!.id);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        runId,
        agentId: agent1Id,
        issueId,
        issueStatus: "done",
        costUsd: "0.42",
        actualExecutor: "claude_local",
      });
      expect(entries[0]!.workProducts).toHaveLength(1);
      expect(entries[0]!.workProducts[0]).toMatchObject({ healthStatus: "healthy" });
    });

    it("returns an empty array for a knowledge record that was never used in any run", async () => {
      await seedCompany(company1Id);
      const [record] = await db.insert(knowledgeRecords).values({
        companyId: company1Id,
        title: "Never used",
        body: "body",
        verificationStatus: "verified",
      }).returning();

      const svc = knowledgeService(db);
      expect(await svc.getKnowledgeUsageEffectiveness(company1Id, record!.id)).toEqual([]);
    });

    it("never includes another company's usage, even for the same knowledge-record id collision window", async () => {
      await seedCompany(company1Id);
      await seedCompany(company2Id);
      await seedAgent(company1Id, agent1Id);
      await seedAgent(company2Id, agent2Id);
      const [record1] = await db.insert(knowledgeRecords).values({
        companyId: company1Id,
        title: "Company 1 knowledge",
        body: "body",
        verificationStatus: "verified",
      }).returning();
      const { runId: run1Id } = await seedRunWithIssueAndWorkProduct(company1Id, agent1Id);
      await db.insert(activityLog).values({
        companyId: company1Id,
        actorType: "system",
        actorId: "heartbeat_context_build",
        entityType: "knowledge_record",
        entityId: record1!.id,
        agentId: agent1Id,
        runId: run1Id,
        action: "knowledge_record.injected_into_context",
      });
      // A different company's activity for an unrelated entityId -- must never surface
      // when querying company1's record, even though both companies share this table.
      const { runId: run2Id } = await seedRunWithIssueAndWorkProduct(company2Id, agent2Id);
      await db.insert(activityLog).values({
        companyId: company2Id,
        actorType: "system",
        actorId: "heartbeat_context_build",
        entityType: "knowledge_record",
        entityId: randomUUID(),
        agentId: agent2Id,
        runId: run2Id,
        action: "knowledge_record.injected_into_context",
      });

      const svc = knowledgeService(db);
      const entries = await svc.getKnowledgeUsageEffectiveness(company1Id, record1!.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.runId).toBe(run1Id);
    });

    it("excludes a run that did not actually use this specific knowledge record, even if other activity exists for the same run", async () => {
      await seedCompany(company1Id);
      await seedAgent(company1Id, agent1Id);
      const [recordA] = await db.insert(knowledgeRecords).values({
        companyId: company1Id, title: "A", body: "body", verificationStatus: "verified",
      }).returning();
      const [recordB] = await db.insert(knowledgeRecords).values({
        companyId: company1Id, title: "B", body: "body", verificationStatus: "verified",
      }).returning();
      const { runId } = await seedRunWithIssueAndWorkProduct(company1Id, agent1Id);
      // Only recordA was actually injected into this run's context.
      await db.insert(activityLog).values({
        companyId: company1Id,
        actorType: "system",
        actorId: "heartbeat_context_build",
        entityType: "knowledge_record",
        entityId: recordA!.id,
        agentId: agent1Id,
        runId,
        action: "knowledge_record.injected_into_context",
      });

      const svc = knowledgeService(db);
      expect(await svc.getKnowledgeUsageEffectiveness(company1Id, recordB!.id)).toEqual([]);
    });
  });
});
