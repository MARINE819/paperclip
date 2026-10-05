import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

// Mirrors the retry-on-FK pattern already used by
// heartbeat-responsible-user-invariant.test.ts: heartbeat_run_events rows can
// still be landing (fire-and-forget) when a delete of heartbeat_runs runs,
// which trips the events table's FK back onto the run row.
async function deleteHeartbeatRunsAfterEvents(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await db.delete(heartbeatRunEvents);
    try {
      await db.delete(heartbeatRuns);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt < 4 &&
        message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
  }
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres paused-company heartbeat guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat paused-company guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-paused-company-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    const heartbeat = heartbeatService(db);
    // Some tests below let tickTimers/wakeup proceed far enough to start a
    // real (fire-and-forget) run execution attempt. Drain those before
    // deleting rows, or the deletes below race the async execution and can
    // both under/over-count rows and violate foreign keys on cleanup.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await deleteHeartbeatRunsAfterEvents(db);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgentWithCompanyStatus(status: "active" | "paused" | "archived") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: `${status} Co`,
      status,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${status} Agent`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
      // Fixed in the past relative to the fixed `now` used by tickTimers()
      // in these tests, so the interval-elapsed check never masks the
      // company-status guard being tested here.
      createdAt: new Date("2026-06-04T00:00:00Z"),
    });

    return { companyId, agentId };
  }

  it("does not iterate paused-company agents in tickTimers", async () => {
    const { agentId } = await insertAgentWithCompanyStatus("paused");

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(new Date("2026-06-04T00:10:00Z"));

    expect(result).toMatchObject({
      checked: 0,
      enqueued: 0,
      skipped: 0,
    });

    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.agentId === agentId).length);
    expect(runCount).toBe(0);
  });

  it("skips background wakeups for a paused company with a company.inactive reason", async () => {
    const { agentId } = await insertAgentWithCompanyStatus("paused");

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: randomUUID(), commentId: randomUUID() },
      requestedByActorType: "system",
      requestedByActorId: "comment_wake",
    });

    expect(run).toBeNull();

    const wakeup = await db
      .select({
        agentId: agentWakeupRequests.agentId,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .then((rows) => rows.find((row) => row.agentId === agentId) ?? null);

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "company.inactive",
      error: "Wake suppressed because company status is paused",
    });
  });

  it("does not resume queued runs for paused companies", async () => {
    const { companyId, agentId } = await insertAgentWithCompanyStatus("paused");
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "queued",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    const status = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .then((rows) => rows[0]?.status ?? null);
    expect(status).toBe("queued");
  });

  it("rejects explicit user invokes for paused companies", async () => {
    const { agentId } = await insertAgentWithCompanyStatus("paused");

    const heartbeat = heartbeatService(db);

    await expect(heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      details: { status: "paused" },
    });

    const runCount = await db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.filter((row) => row.agentId === agentId).length);
    expect(runCount).toBe(0);
  });

  it("still ticks and enqueues an agent in an unrelated active company while another company is paused", async () => {
    const { agentId: pausedAgentId } = await insertAgentWithCompanyStatus("paused");
    const { companyId: activeCompanyId, agentId: activeAgentId } = await insertAgentWithCompanyStatus("active");

    await db.insert(issues).values({
      id: randomUUID(),
      companyId: activeCompanyId,
      assigneeAgentId: activeAgentId,
      title: "Active agent task",
      status: "todo",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.tickTimers(new Date("2026-06-04T00:10:00Z"));

    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(0);

    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns);
    const runAgentIds = runs.map((r) => r.agentId);

    expect(runAgentIds).toContain(activeAgentId);
    expect(runAgentIds).not.toContain(pausedAgentId);
  });

  it("resumes normal tick behavior after a paused company transitions back to active", async () => {
    const { companyId, agentId } = await insertAgentWithCompanyStatus("paused");

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      assigneeAgentId: agentId,
      title: "Resumed agent task",
      status: "todo",
    });

    const heartbeat = heartbeatService(db);
    const blockedResult = await heartbeat.tickTimers(new Date("2026-06-04T00:10:00Z"));
    expect(blockedResult.enqueued).toBe(0);

    await db.update(companies).set({ status: "active" }).where(eq(companies.id, companyId));

    const resumedResult = await heartbeat.tickTimers(new Date("2026-06-04T00:11:00Z"));
    expect(resumedResult.enqueued).toBe(1);

    const runAgentIds = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .then((rows) => rows.map((r) => r.agentId));
    expect(runAgentIds).toContain(agentId);
  });
});
