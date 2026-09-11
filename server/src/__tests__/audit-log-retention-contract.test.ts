import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  decisionArchiveNotificationOutbox,
  decisionRetention,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { logActivity } from "../services/activity-log.js";
import { attentionService } from "../services/attention.js";
import { decisionRetentionService, DEFAULT_DECISION_ARCHIVE_DAYS } from "../services/decision-retention.js";

// This file characterizes the CURRENT "Audit log / evidence retention" Core v0.1
// Closure item. It does not assert that the current hard-delete behavior (Policy A)
// is the desired contract — see reports/operations/audit-retention-contract-verification-plan-2026-09-07.md
// §14-§17 for the policy comparison (A/B/C) and why this file's naming is deliberate.

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

const DAY_MS = 86_400_000;

describePg("audit log retention contract", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-audit-retention-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(decisionArchiveNotificationOutbox);
    await db.delete(decisionRetention);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Audit Retention Test Co",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Origin Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("proves single-E2E reconstruction: issue create -> approval create -> approval approve -> issue update are recoverable in order from activity_log", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "E2E-1",
      title: "Reconstruction target issue",
      status: "in_progress",
      priority: "medium",
      createdByAgentId: agentId,
    });
    const approvalId = randomUUID();

    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.created",
      entityType: "issue",
      entityId: issueId,
      details: { title: "Reconstruction target issue" },
    });
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approvalId,
      issueId,
      details: { issueId },
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "approval.approved",
      entityType: "approval",
      entityId: approvalId,
      issueId,
      details: { issueId },
    });
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "done" },
    });

    const rows = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(asc(activityLog.createdAt));

    expect(rows.map((row) => row.action)).toEqual([
      "issue.created",
      "approval.created",
      "approval.approved",
      "issue.updated",
    ]);
    expect(rows[0]).toMatchObject({ actorType: "agent", actorId: agentId, entityType: "issue", entityId: issueId });
    expect(rows[1]).toMatchObject({ actorType: "agent", actorId: agentId, entityType: "approval", entityId: approvalId });
    expect(rows[2]).toMatchObject({ actorType: "user", actorId: "board-user", entityType: "approval", entityId: approvalId });
    expect(rows[3]).toMatchObject({ actorType: "agent", actorId: agentId, entityType: "issue", entityId: issueId });
  });

  it("preserves activity_log across company archive/reactivate (routine operation, not a hard delete)", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const actor = { actorType: "user" as const, actorId: "test-user", agentId: null, runId: null };

    const archived = await companyService(db).archive(companyId, actor);
    expect(archived?.status).toBe("archived");

    const afterArchive = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(afterArchive).toHaveLength(1);
    expect(afterArchive[0]).toMatchObject({ action: "company.archived" });

    const reactivated = await companyService(db).update(companyId, { status: "active" }, actor);
    expect(reactivated?.status).toBe("active");

    const afterReactivate = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(asc(activityLog.createdAt));
    expect(afterReactivate.map((row) => row.action)).toEqual(["company.archived", "company.reactivated"]);
  });

  it("documents CURRENT Policy-A behavior — hard delete removes activity_log regardless of row age (NOT the recommended contract, see verification plan report §15)", async () => {
    const { companyId } = await seedCompanyAndAgent();

    // A row old enough that no plausible retention floor would justify deleting it.
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "test-seed",
      action: "issue.created",
      entityType: "issue",
      entityId: randomUUID(),
      createdAt: new Date(Date.now() - 400 * DAY_MS),
    });
    // A row created moments ago.
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "test-seed",
      action: "issue.updated",
      entityType: "issue",
      entityId: randomUUID(),
    });

    const beforeRemoval = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(beforeRemoval).toHaveLength(2);

    await companyService(db).remove(companyId);

    const afterRemoval = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    // This is a characterization of what the code does today, not a statement that
    // it should do this. Passing here means "Policy A is still in effect", not
    // "Audit retention is verified sufficient" — see report §15-§17.
    expect(afterRemoval).toHaveLength(0);
  });

  it.skip("Policy C target (NOT YET IMPLEMENTED): hard delete preserves prior activity_log rows and records a durable deletion event — see verification plan report §15/§19 for the pending CEO/Human policy decision and required schema change", async () => {
    const { companyId } = await seedCompanyAndAgent();
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "test-seed",
      action: "issue.created",
      entityType: "issue",
      entityId: randomUUID(),
    });

    await companyService(db).remove(companyId);

    // Target behavior once Policy C is implemented: prior rows survive, and exactly
    // one durable "entity.hard_deleted" style event exists somewhere that is not
    // itself scoped to (and therefore wiped with) the deleted company.
    const survivingRows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(survivingRows).toHaveLength(1);
    // Placeholder assertion for the not-yet-existing deletion-event record.
    expect(false).toBe(true);
  });

  it("decision-retention 90-day boundary: an item exactly at the cutoff archives, an item one day short of it does not", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const now = new Date("2026-08-02T00:00:00.000Z");
    const oldIssueId = randomUUID();
    const recentIssueId = randomUUID();
    const oldActivityAt = new Date(now.getTime() - DEFAULT_DECISION_ARCHIVE_DAYS * DAY_MS);
    const recentActivityAt = new Date(now.getTime() - (DEFAULT_DECISION_ARCHIVE_DAYS - 1) * DAY_MS);

    await db.insert(issues).values([
      {
        id: oldIssueId,
        companyId,
        identifier: "RET-OLD",
        title: "Exactly at 90-day cutoff",
        status: "in_review",
        priority: "medium",
        assigneeUserId: "board-user",
        createdByAgentId: agentId,
        createdAt: oldActivityAt,
        updatedAt: oldActivityAt,
      },
      {
        id: recentIssueId,
        companyId,
        identifier: "RET-RECENT",
        title: "One day short of the 90-day cutoff",
        status: "in_review",
        priority: "medium",
        assigneeUserId: "board-user",
        createdByAgentId: agentId,
        createdAt: recentActivityAt,
        updatedAt: recentActivityAt,
      },
    ]);

    const svc = decisionRetentionService(db);
    const feed = await attentionService(db, { now: () => now.getTime() }).list(companyId, { limit: 100 });
    expect(feed.items).toHaveLength(2);

    const archivedCount = await svc.autoArchive({ companyId, items: feed.items, now });
    expect(archivedCount).toBe(1);

    const oldState = await svc.getState(companyId, "review", oldIssueId);
    const recentState = await svc.getState(companyId, "review", recentIssueId);
    expect(oldState?.archivedAt).not.toBeNull();
    expect(recentState?.archivedAt ?? null).toBeNull();
  });
});
