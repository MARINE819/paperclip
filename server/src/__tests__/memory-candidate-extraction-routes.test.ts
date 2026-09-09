import { createHash, randomUUID } from "node:crypto";
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
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issues,
  memoryOperations,
  principalPermissionGrants,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { knowledgeRoutes } from "../routes/knowledge.js";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

/**
 * Phase 3.0 (explicit API variant, "3.0A"): deterministic Memory Operation
 * candidate extraction from a completed Issue's existing Continuation
 * Summary document. This is triggered only by
 * `POST /api/issues/:id/extract-memory-candidate` — never automatically —
 * so it exercises no code path in `server/src/services/issues.ts` or
 * `heartbeat.ts`.
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
  await db.delete(memoryOperations);
  await db.delete(issueDocuments);
  await db.delete(documentRevisions);
  await db.delete(documents);
  await db.delete(heartbeatRuns);
  await db.delete(issues);
  await db.delete(agents);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describeEmbeddedPostgres("memory candidate extraction (Phase 3.0A explicit API)", () => {
  const ctx = useEmbeddedPostgres("paperclip-memory-candidate-extraction-", { resetEach: resetFixtures });

  async function seedIssue(companyId: string, status = "backlog") {
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix flaky retry loop",
      identifier: `NEX-${issueId.slice(0, 8)}`,
      status,
    });
    return issueId;
  }

  async function seedAgentAndRun(companyId: string) {
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({ id: agentId, companyId, name: "Builder" });
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId });
    return { agentId, runId };
  }

  async function seedContinuationSummary(
    companyId: string,
    issueId: string,
    opts: { body?: string; agentId?: string | null; runId?: string | null } = {},
  ) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const body = opts.body ?? "# Continuation Summary\n\n- Status: done\n- Next Action: none";
    await ctx.db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
    });
    await ctx.db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body,
      createdByAgentId: opts.agentId ?? null,
      createdByRunId: opts.runId ?? null,
    });
    await ctx.db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
    return { documentId, revisionId, body };
  }

  async function extract(app: express.Express, issueId: string) {
    return request(app).post(`/api/issues/${issueId}/extract-memory-candidate`).send({}).then((r) => r);
  }

  it("[1,2,3,4,5] creates exactly one candidate with preserved markdown, correct status, provenance, and metadata", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Extraction Co");
    const issueId = await seedIssue(company.companyId, "done");
    const { agentId, runId } = await seedAgentAndRun(company.companyId);
    const { documentId, revisionId, body } = await seedContinuationSummary(company.companyId, issueId, { agentId, runId });
    const app = buildApp(ctx.db, company.actor);

    const res = await extract(app, issueId);

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const op = res.body.memoryOperation;
    expect(op.content).toBe(body); // verbatim, byte-for-byte
    expect(op.status).toBe("candidate");
    expect(op.reviewState).toBe("pending");
    expect(op.confidence).toBeNull();
    expect(op.sourceType).toBe("document");
    expect(op.sourceId).toBe(revisionId);
    expect(op.sourceIssueId).toBe(issueId);
    expect(op.sourceRunId).toBe(runId);
    expect(op.sourceAgentId).toBe(agentId);

    const expectedHash = sha256Hex(body);
    expect(op.metadata).toMatchObject({
      extractorVersion: "continuation-summary-v1",
      extractionReason: "issue_completed_continuation_summary",
      contentHash: expectedHash,
      sourceSnapshot: { documentId, revisionId, revisionNumber: 1, issueId },
    });
    expect(typeof op.metadata.extractedAt).toBe("string");

    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));
    expect(rows).toHaveLength(1);
  });

  it("[6,8] processing the same event twice yields exactly one candidate and one activity log entry", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Extraction Co");
    const issueId = await seedIssue(company.companyId, "done");
    await seedContinuationSummary(company.companyId, issueId);
    const app = buildApp(ctx.db, company.actor);

    const first = await extract(app, issueId);
    const second = await extract(app, issueId);

    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.reason).toBe("already_extracted");
    expect(second.body.memoryOperation.id).toBe(first.body.memoryOperation.id);

    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));
    expect(rows).toHaveLength(1);

    const logged = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "memory_operation.extracted"));
    expect(logged).toHaveLength(1);
    // Phase 3.0A is an explicit Board call, so it is attributed to the real
    // calling Board actor — never a synthetic "system" identity. (A future
    // Phase 3.0B automatic hook would use "system" instead; this module
    // never does.)
    expect(logged[0]).toMatchObject({
      actorType: "user",
      actorId: company.userId,
      entityType: "memory_operation",
      entityId: first.body.memoryOperation.id,
    });
    expect(logged[0]!.details).toMatchObject({
      sourceType: "document",
      extractorVersion: "continuation-summary-v1",
    });
    // Never the raw markdown, never an absolute path.
    expect(JSON.stringify(logged[0]!.details)).not.toContain("Continuation Summary\n");
  });

  it("[7] concurrent duplicate extraction requests still yield exactly one candidate", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Extraction Co");
    const issueId = await seedIssue(company.companyId, "done");
    await seedContinuationSummary(company.companyId, issueId);
    const app = buildApp(ctx.db, company.actor);

    const [res1, res2] = await Promise.all([extract(app, issueId), extract(app, issueId)]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 201]);
    const createdIds = new Set([res1.body.memoryOperation.id, res2.body.memoryOperation.id]);
    expect(createdIds.size).toBe(1); // both point at the same row

    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));
    expect(rows).toHaveLength(1);

    const logged = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "memory_operation.extracted"));
    expect(logged).toHaveLength(1);
  });

  it("rejects an agent actor with 403 before any DB lookup, creating no candidate and no activity log entry", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Extraction Co");
    const agentActor: AgentActor = {
      type: "agent",
      agentId: randomUUID(),
      companyId: company.companyId,
      runId: null,
      keyId: null,
      source: "agent_key",
    };
    const app = buildApp(ctx.db, agentActor);

    // Deliberately a non-existent issue id: if assertBoard ran after the DB
    // lookup, this would surface as 404 instead of 403, leaking whether the
    // id exists. Getting 403 here proves the Board check runs first.
    const res = await extract(app, randomUUID());

    expect(res.status).toBe(403);
    const rows = await ctx.db.select().from(memoryOperations);
    expect(rows).toHaveLength(0);
    const logged = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "memory_operation.extracted"));
    expect(logged).toHaveLength(0);
  });

  it("blocks another company's board actor with 404, matching existing cross-tenant conventions", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Extraction Co");
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");
    const issueId = await seedIssue(company.companyId, "done");
    await seedContinuationSummary(company.companyId, issueId);
    const app = buildApp(ctx.db, otherCompany.actor);

    const res = await extract(app, issueId);

    expect(res.status).toBe(404);
    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));
    expect(rows).toHaveLength(0);
  });

  it("[9,12] blocks a cross-company source reference and leaves the issue untouched", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Extraction Co");
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");
    const issueId = await seedIssue(company.companyId, "done");
    const otherAgentId = randomUUID();
    await ctx.db.insert(agents).values({ id: otherAgentId, companyId: otherCompany.companyId, name: "Other Agent" });
    await seedContinuationSummary(company.companyId, issueId, { agentId: otherAgentId });
    const app = buildApp(ctx.db, company.actor);

    const [issueBefore] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    const res = await extract(app, issueId);

    expect(res.status).toBe(422);
    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));
    expect(rows).toHaveLength(0);

    const [issueAfter] = await ctx.db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueAfter).toEqual(issueBefore); // issue completely unchanged by the failed extraction
  });

  it("[10] returns zero candidates when the issue has no continuation-summary document", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Extraction Co");
    const issueId = await seedIssue(company.companyId, "done");
    const app = buildApp(ctx.db, company.actor);

    const res = await extract(app, issueId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: false, reason: "no_completion_document" });
    const rows = await ctx.db.select().from(memoryOperations);
    expect(rows).toHaveLength(0);
  });

  it("[11] returns zero candidates for an empty document body and for a not-yet-done issue", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Extraction Co");
    const app = buildApp(ctx.db, company.actor);

    const emptyBodyIssueId = await seedIssue(company.companyId, "done");
    await seedContinuationSummary(company.companyId, emptyBodyIssueId, { body: "   \n\n  " });
    const emptyRes = await extract(app, emptyBodyIssueId);
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.body).toEqual({ created: false, reason: "empty_document" });

    const notDoneIssueId = await seedIssue(company.companyId, "in_progress");
    await seedContinuationSummary(company.companyId, notDoneIssueId);
    const notDoneRes = await extract(app, notDoneIssueId);
    expect(notDoneRes.status).toBe(200);
    expect(notDoneRes.body).toEqual({ created: false, reason: "issue_not_done" });

    const rows = await ctx.db.select().from(memoryOperations);
    expect(rows).toHaveLength(0);
  });

  it("[13,14] an auto-extracted candidate cannot be promoted before Board review, and the normal flow works after approval", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Extraction Co");
    const issueId = await seedIssue(company.companyId, "done");
    await seedContinuationSummary(company.companyId, issueId);
    const app = buildApp(ctx.db, company.actor);

    const created = await extract(app, issueId);
    const operationId = created.body.memoryOperation.id;

    const prematurePromote = await request(app).post(`/api/memory-operations/${operationId}/promote`).send({});
    expect(prematurePromote.status).toBe(409);

    const review = await request(app).post(`/api/memory-operations/${operationId}/review`).send({ reviewState: "approved" });
    expect(review.status).toBe(200);
    expect(review.body.reviewState).toBe("approved");

    const promote = await request(app).post(`/api/memory-operations/${operationId}/promote`).send({});
    expect(promote.status).toBe(201);
    expect(promote.body.knowledgeRecord.sourceMemoryOperationId).toBe(operationId);
  });
});
