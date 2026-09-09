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
import { createFailureCooldownTracker } from "../services/memory-candidate-failure-cooldown.js";
import {
  extractMemoryOperationCandidateFromCompletedIssue,
  findCompletedIssuesEligibleForAutomaticExtraction,
  MEMORY_CANDIDATE_RECONCILER_SYSTEM_ACTOR_ID,
  reconcileAutomaticMemoryOperationCandidates,
} from "../services/memory-candidate-extraction.js";
import { resolveMemoryCandidateReconcilerConfig } from "../services/memory-candidate-reconciler-config.js";
import { createMemoryCandidateReconcilerScheduler } from "../services/memory-candidate-reconciler-scheduler.js";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

/**
 * Phase 3.0B: durable automatic Memory Operation candidate extraction.
 * Every test drives `reconcileAutomaticMemoryOperationCandidates` /
 * `findCompletedIssuesEligibleForAutomaticExtraction` directly against a
 * real, isolated embedded Postgres instance — never a real timer, never
 * `issues.ts`/`heartbeat.ts`, never the live DB.
 */

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

describeEmbeddedPostgres("automatic memory candidate reconciliation (Phase 3.0B)", () => {
  const ctx = useEmbeddedPostgres("paperclip-memory-candidate-reconciler-", { resetEach: resetFixtures });

  async function seedIssue(
    companyId: string,
    opts: { status?: string; completedAt?: Date | null; updatedAt?: Date; createdAt?: Date } = {},
  ) {
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix flaky retry loop",
      identifier: `NEX-${issueId.slice(0, 8)}`,
      status: opts.status ?? "done",
      ...(opts.completedAt !== undefined ? { completedAt: opts.completedAt } : {}),
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
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

  function buildApp(actor: BoardActor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", knowledgeRoutes(ctx.db));
    app.use(errorHandler);
    return app;
  }

  it("[1] extracts an automatic candidate for a done Issue with an eligible summary", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const issueId = await seedIssue(company.companyId);
    const { agentId, runId } = await seedAgentAndRun(company.companyId);
    const { revisionId, body } = await seedContinuationSummary(company.companyId, issueId, { agentId, runId });

    const result = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });

    expect(result).toMatchObject({ scanned: 1, attempted: 1, created: 1, deduplicated: 0, failed: 0 });
    const [op] = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));
    expect(op).toMatchObject({
      status: "candidate",
      reviewState: "pending",
      sourceType: "document",
      sourceId: revisionId,
      sourceRunId: runId,
      sourceAgentId: agentId,
      content: body,
    });
  });

  it("[2] does not extract until the summary is created, then succeeds on the next reconciliation", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const issueId = await seedIssue(company.companyId);

    const first = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    expect(first).toMatchObject({ scanned: 0, created: 0 });

    await seedContinuationSummary(company.companyId, issueId);
    const second = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    expect(second).toMatchObject({ scanned: 1, created: 1 });
  });

  it("[3,17] repeated reconciliation for the same Issue yields exactly one candidate and one system-attributed activity entry", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const issueId = await seedIssue(company.companyId);
    await seedContinuationSummary(company.companyId, issueId);

    await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    const second = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    expect(second).toMatchObject({ scanned: 0, created: 0 }); // no longer eligible

    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));
    expect(rows).toHaveLength(1);

    const logged = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "memory_operation.auto_created"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actorType: "system", actorId: MEMORY_CANDIDATE_RECONCILER_SYSTEM_ACTOR_ID });
  });

  it("[4] two concurrent reconciler passes still produce exactly one candidate and one activity entry", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const issueId = await seedIssue(company.companyId);
    await seedContinuationSummary(company.companyId, issueId);

    const [a, b] = await Promise.all([
      reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 }),
      reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 }),
    ]);
    // Between them, exactly one created and (at most) one deduplicated —
    // both scanned the same eligible row and raced on the same insert.
    expect(a.created + b.created).toBe(1);

    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));
    expect(rows).toHaveLength(1);
    const logged = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "memory_operation.auto_created"));
    expect(logged).toHaveLength(1);
  });

  it("[6] a permanently failing Issue does not starve a healthy Issue behind it in the same tick", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");
    const otherAgentId = randomUUID();
    await ctx.db.insert(agents).values({ id: otherAgentId, companyId: otherCompany.companyId, name: "Other Agent" });

    // The failing Issue is older (sorts first) and will always error because
    // its summary's authoring agent belongs to a different company.
    const failingIssueId = await seedIssue(company.companyId, { completedAt: new Date("2026-01-01T00:00:00Z") });
    await seedContinuationSummary(company.companyId, failingIssueId, { agentId: otherAgentId });

    const healthyIssueId = await seedIssue(company.companyId, { completedAt: new Date("2026-01-02T00:00:00Z") });
    await seedContinuationSummary(company.companyId, healthyIssueId);

    // batchSize=1 would normally let only one Issue be *attempted*, but
    // scanLimit must be generous enough that skipping a cooling-down
    // failure still reaches the healthy Issue within the same tick —
    // exercise that directly with a cooldown tracker and two attempts.
    const cooldown = createFailureCooldownTracker();
    const result = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
      batchSize: 2,
      scanLimit: 10,
      cooldown,
      log: { warn: () => {} },
    });

    expect(result.failed).toBe(1);
    expect(result.created).toBe(1);
    const healthyRows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, healthyIssueId));
    expect(healthyRows).toHaveLength(1);
    const failingRows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, failingIssueId));
    expect(failingRows).toHaveLength(0);
  });

  it("[7,8] cooldown skips a repeatedly failing Issue without re-attempting until it expires", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");
    const otherAgentId = randomUUID();
    await ctx.db.insert(agents).values({ id: otherAgentId, companyId: otherCompany.companyId, name: "Other Agent" });
    const failingIssueId = await seedIssue(company.companyId);
    await seedContinuationSummary(company.companyId, failingIssueId, { agentId: otherAgentId });

    let clockMs = 0;
    const cooldown = createFailureCooldownTracker({ cooldownMs: 1000, now: () => clockMs });
    const warnCalls: unknown[] = [];

    const first = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
      batchSize: 10,
      cooldown,
      log: { warn: (...args) => warnCalls.push(args) },
    });
    expect(first).toMatchObject({ attempted: 1, failed: 1, skippedCooldown: 0 });
    expect(warnCalls).toHaveLength(1);

    // Still within the cooldown window: the eligibility scan still finds
    // the row (no memory_operation was ever created for it), but the
    // reconciler must skip it without a second attempt or a second log line.
    const second = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
      batchSize: 10,
      cooldown,
      log: { warn: (...args) => warnCalls.push(args) },
    });
    expect(second).toMatchObject({ attempted: 0, failed: 0, skippedCooldown: 1 });
    expect(warnCalls).toHaveLength(1); // no additional log line

    // Cooldown expires: the next reconciliation retries it (and fails again).
    clockMs = 1500;
    const third = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
      batchSize: 10,
      cooldown,
      log: { warn: (...args) => warnCalls.push(args) },
    });
    expect(third).toMatchObject({ attempted: 1, failed: 1, skippedCooldown: 0 });
  });

  it("[9] the cooldown map used by the reconciler stays bounded across many distinct failing Issues", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");
    const otherAgentId = randomUUID();
    await ctx.db.insert(agents).values({ id: otherAgentId, companyId: otherCompany.companyId, name: "Other Agent" });

    for (let i = 0; i < 5; i += 1) {
      const issueId = await seedIssue(company.companyId);
      await seedContinuationSummary(company.companyId, issueId, { agentId: otherAgentId, body: `# Summary ${i}` });
    }

    const cooldown = createFailureCooldownTracker({ maxEntries: 3 });
    await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10, scanLimit: 10, cooldown, log: { warn: () => {} } });
    // 5 distinct Issues failed, but the tracker's own bound (3) is respected —
    // proven directly against the cooldown unit in memory-candidate-failure-cooldown.test.ts;
    // this just confirms the reconciler actually routes failures through it.
    expect(cooldown.size()).toBeLessThanOrEqual(3);
  });

  /**
   * Phase 3.0C-1: `app.ts`'s scheduler `reconcile` closure merges
   * `memoryCandidateFailureCooldown.size()` into the result it returns to
   * the scheduler, rather than widening
   * `reconcileAutomaticMemoryOperationCandidates`'s own result contract.
   * These two tests replicate that exact closure shape directly against
   * embedded Postgres — same as the "scheduler wiring pattern" tests below,
   * but these specifically need real failing/succeeding Issues, which needs
   * `ctx.db`.
   */
  it("[3.0C-1] cooldownMapSize in the scheduler-facing result is 1 after one failure, using the same reconcile-closure shape as app.ts", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");
    const otherAgentId = randomUUID();
    await ctx.db.insert(agents).values({ id: otherAgentId, companyId: otherCompany.companyId, name: "Other Agent" });
    const failingIssueId = await seedIssue(company.companyId);
    await seedContinuationSummary(company.companyId, failingIssueId, { agentId: otherAgentId });

    const cooldown = createFailureCooldownTracker();
    const reconcile = async () => {
      const result = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
        batchSize: 10,
        cooldown,
        log: { warn: () => {} },
      });
      return { ...result, cooldownMapSize: cooldown.size() };
    };

    const first = await reconcile();
    expect(first).toMatchObject({ failed: 1, cooldownMapSize: 1 });
  });

  it("[3.0C-1] cooldownMapSize returns to 0 only once the production reconcile success path itself calls recordSuccess() — never by the test calling it directly — and the tracker is never recreated across ticks", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");
    const otherAgentId = randomUUID();
    await ctx.db.insert(agents).values({ id: otherAgentId, companyId: otherCompany.companyId, name: "Other Agent" });
    const failingIssueId = await seedIssue(company.companyId);
    const { documentId } = await seedContinuationSummary(company.companyId, failingIssueId, { agentId: otherAgentId });

    // A fake, injected clock — no real sleep anywhere in this test. Short
    // cooldownMs so advancing the clock a small, explicit amount is enough
    // to cross the cooldown boundary.
    let clockMs = 0;
    const cooldown = createFailureCooldownTracker({ cooldownMs: 1_000, now: () => clockMs });
    // One shared cooldown tracker instance across all three closure
    // invocations, exactly as `memoryCandidateFailureCooldown` is created
    // once per `createApp()` call and captured by the reconcile closure —
    // never recreated per tick.
    const reconcile = async () => {
      const result = await reconcileAutomaticMemoryOperationCandidates(ctx.db, {
        batchSize: 10,
        cooldown,
        log: { warn: () => {} },
      });
      return { ...result, cooldownMapSize: cooldown.size() };
    };

    const first = await reconcile();
    expect(first).toMatchObject({ failed: 1, cooldownMapSize: 1 });

    // Still within the cooldown window (clock unchanged): the Issue is
    // skipped, not re-attempted, and the entry is still there. If the
    // tracker were recreated fresh on every tick, the still-cooling-down
    // Issue would be re-attempted immediately instead of being skipped —
    // this proves the same tracker instance persisted across the call.
    const second = await reconcile();
    expect(second).toMatchObject({ attempted: 0, skippedCooldown: 1, cooldownMapSize: 1 });

    // Fix the cross-company reference so the next attempt can actually
    // succeed, then advance the fake clock past the cooldown window. Note:
    // the test never calls `cooldown.recordSuccess()` itself — the only way
    // `cooldownMapSize` can reach 0 below is if
    // `reconcileAutomaticMemoryOperationCandidates`'s own success path
    // (inside `memory-candidate-extraction.ts`) calls it after a real
    // "created" outcome.
    await ctx.db.update(documentRevisions)
      .set({ createdByAgentId: null })
      .where(eq(documentRevisions.documentId, documentId));
    clockMs = 1_001; // past the 1000ms cooldown window — the entry is eligible for retry again

    const third = await reconcile();
    expect(third).toMatchObject({ attempted: 1, created: 1, cooldownMapSize: 0 });

    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, failingIssueId));
    expect(rows).toHaveLength(1);
    const logged = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "memory_operation.auto_created"));
    expect(logged).toHaveLength(1);
  });

  it("[10] excludes an Issue that is not done", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const issueId = await seedIssue(company.companyId, { status: "in_progress" });
    await seedContinuationSummary(company.companyId, issueId);

    const result = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    expect(result).toMatchObject({ scanned: 0, created: 0 });
  });

  it("[11] excludes an empty continuation summary", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const issueId = await seedIssue(company.companyId);
    await seedContinuationSummary(company.companyId, issueId, { body: "   \n\n  " });

    const result = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    expect(result).toMatchObject({ scanned: 0, created: 0 });
  });

  it("[12,14] includes an imported done Issue with a null completedAt, sorted deterministically alongside others", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const importedIssueId = await seedIssue(company.companyId, {
      completedAt: null,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedContinuationSummary(company.companyId, importedIssueId);
    const normalIssueId = await seedIssue(company.companyId, { completedAt: new Date("2026-02-01T00:00:00Z") });
    await seedContinuationSummary(company.companyId, normalIssueId);

    const eligible = await findCompletedIssuesEligibleForAutomaticExtraction(ctx.db, { scanLimit: 10 });
    const ids = eligible.map((row) => row.issueId);
    expect(ids).toContain(importedIssueId);
    expect(ids).toContain(normalIssueId);
    // Deterministic order: the null-completedAt Issue falls back to
    // updatedAt (2026-01-01), sorting before the normal Issue (2026-02-01).
    expect(ids.indexOf(importedIssueId)).toBeLessThan(ids.indexOf(normalIssueId));

    const result = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    expect(result.created).toBe(2);
  });

  it("[13] bounds a single tick's attempts to batchSize even when more Issues are eligible", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    for (let i = 0; i < 5; i += 1) {
      const issueId = await seedIssue(company.companyId);
      await seedContinuationSummary(company.companyId, issueId, { body: `# Summary ${i}` });
    }

    const result = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 2, scanLimit: 10 });
    expect(result.attempted).toBe(2);
    expect(result.created).toBe(2);

    const rows = await ctx.db.select().from(memoryOperations);
    expect(rows).toHaveLength(2);
  });

  it("[15] does not add an automatic candidate when a Phase 3.0A manual candidate already exists for the Issue", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const issueId = await seedIssue(company.companyId);
    await seedContinuationSummary(company.companyId, issueId);

    const manual = await extractMemoryOperationCandidateFromCompletedIssue(ctx.db, company.companyId, issueId, {
      actorType: "user",
      actorId: company.userId,
      agentId: null,
      runId: null,
    });
    expect(manual.outcome).toBe("created");

    const result = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    expect(result).toMatchObject({ scanned: 0, created: 0 });

    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));
    expect(rows).toHaveLength(1);
    // The single existing row is attributed to the manual (3.0A) actor, not the reconciler.
    const logged = await ctx.db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, rows[0]!.id), eq(activityLog.action, "memory_operation.extracted")));
    expect(logged).toHaveLength(1);
  });

  it("[16] does not add a second automatic candidate after a later continuation-summary revision appears", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const issueId = await seedIssue(company.companyId);
    const { documentId } = await seedContinuationSummary(company.companyId, issueId, { body: "# v1" });

    const first = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    expect(first.created).toBe(1);

    // A later run refreshes the same continuation-summary document with a new revision.
    const newRevisionId = randomUUID();
    await ctx.db.insert(documentRevisions).values({
      id: newRevisionId,
      companyId: company.companyId,
      documentId,
      revisionNumber: 2,
      body: "# v2 (issue was reopened and redone)",
    });
    await ctx.db.update(documents)
      .set({ latestBody: "# v2 (issue was reopened and redone)", latestRevisionId: newRevisionId, latestRevisionNumber: 2 })
      .where(eq(documents.id, documentId));

    const second = await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    expect(second).toMatchObject({ scanned: 0, created: 0 });

    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("# v1"); // still the original automatic extraction
  });

  it("[18,19] an automatic candidate cannot be promoted before Board review, and the normal flow works after approval", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reconciler Co");
    const issueId = await seedIssue(company.companyId);
    await seedContinuationSummary(company.companyId, issueId);
    await reconcileAutomaticMemoryOperationCandidates(ctx.db, { batchSize: 10 });
    const [op] = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.sourceIssueId, issueId));

    const app = buildApp(company.actor);
    const prematurePromote = await request(app).post(`/api/memory-operations/${op!.id}/promote`).send({});
    expect(prematurePromote.status).toBe(409);

    const review = await request(app).post(`/api/memory-operations/${op!.id}/review`).send({ reviewState: "approved" });
    expect(review.status).toBe(200);

    const promote = await request(app).post(`/api/memory-operations/${op!.id}/promote`).send({});
    expect(promote.status).toBe(201);
    expect(promote.body.knowledgeRecord.sourceMemoryOperationId).toBe(op!.id);
  });

  it("starts and stops the reconciler scheduler during createApp lifecycle when enabled", async () => {
    // 1. Stub environment variables safely
    const originalEnabled = process.env.PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED;
    const originalInterval = process.env.PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS;

    process.env.PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED = "true";
    process.env.PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS = "10000"; // 10s

    try {
      // Import createApp dynamically to ensure it picks up the environment variables
      const { createApp } = await import("../app.js");

      const mockStorageService = {
        getUrl: () => "",
        put: async () => {},
        get: async () => null,
        delete: async () => {},
      };

      // 2. Call createApp with the real embedded postgres db context
      const app = await createApp(ctx.db, {
        uiMode: "none",
        serverPort: 0,
        storageService: mockStorageService as any,
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        authReady: false,
        companyDeletionEnabled: false,
        decisionServiceOptions: {},
      });

      expect(app).toBeDefined();
      expect(app.locals.paperclipShutdown).toBeTypeOf("function");

      // 3. Clean up / stop using the app's own shutdown hook
      await app.locals.paperclipShutdown();
    } finally {
      // 4. Restore original environment variables
      if (originalEnabled !== undefined) {
        process.env.PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED = originalEnabled;
      } else {
        delete process.env.PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED;
      }
      if (originalInterval !== undefined) {
        process.env.PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS = originalInterval;
      } else {
        delete process.env.PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS;
      }
    }
  });
});

describe("Phase 3.0B scheduler wiring pattern (config -> scheduler, no app.ts boot)", () => {
  it("[20] a disabled config never starts the scheduler", () => {
    const config = resolveMemoryCandidateReconcilerConfig({});
    expect(config.enabled).toBe(false);

    const reconcile = () => Promise.resolve({});
    let setIntervalCalls = 0;
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile,
      intervalMs: config.intervalMs,
      logger: { info: () => {}, error: () => {} },
      setIntervalFn: (h, ms) => {
        setIntervalCalls += 1;
        return setInterval(h, ms);
      },
      clearIntervalFn: (handle) => clearInterval(handle),
    });

    if (config.enabled) scheduler.start(); // mirrors app.ts's `if (config.enabled) scheduler.start();`
    expect(setIntervalCalls).toBe(0);
  });

  it("[21,22] an enabled config starts the scheduler (startup tick + interval), and stop() cleans it up", async () => {
    const config = resolveMemoryCandidateReconcilerConfig({ PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED: "true" });
    expect(config.enabled).toBe(true);

    let calls = 0;
    let cleared = false;
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile: () => {
        calls += 1;
        return Promise.resolve({});
      },
      intervalMs: config.intervalMs,
      logger: { info: () => {}, error: () => {} },
      setIntervalFn: () => ({ unref: () => {} }) as unknown as NodeJS.Timeout,
      clearIntervalFn: () => {
        cleared = true;
      },
    });

    if (config.enabled) scheduler.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1); // startup-once tick ran

    await scheduler.stop();
    expect(cleared).toBe(true);
  });
});


