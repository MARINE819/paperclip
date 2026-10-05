import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import { createDb, memoryOperations, runtimeIncidents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  routeApp,
  seedCompanyWithBoardAccess,
  type BoardActor,
} from "./helpers/route-test-harness.js";
import { instanceIncidentRoutes } from "../routes/instance-incidents.js";
import { promoteIncidentFailureMemoryToCandidate } from "../services/failure-memory-promotion.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping JARVIS-01 failure-memory-promotion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-failure-memory-");
  cleanups.push(testDb.cleanup);
  return createDb(testDb.connectionString);
}

const DRAFT = {
  problem: "windows_control_c_exit_detected observed on instance default",
  symptoms: ['{"pid":1234,"port":54329}'],
  rootCause: "UNKNOWN",
  failedAttempts: [] as string[],
  verifiedRecovery: "Condition cleared on a subsequent scan; see evidence.",
  evidence: ['{"pid":1234,"port":54329,"logLine":"internal lifecycle detail"}'],
  recurrencePrevention: "Not yet defined — candidate only, human review required before promotion.",
};

async function seedIncident(
  db: Db,
  overrides: Partial<{
    status: string;
    failureMemoryCandidate: boolean;
    failureMemoryDraft: typeof DRAFT | null;
  }> = {},
) {
  const [incident] = await db.insert(runtimeIncidents).values({
    fingerprint: `fp-${randomUUID()}`,
    code: "windows_control_c_exit_detected",
    severity: "high",
    status: overrides.status ?? "resolved",
    source: "test",
    failureMemoryCandidate: overrides.failureMemoryCandidate ?? true,
    failureMemoryDraft: overrides.failureMemoryDraft === undefined ? DRAFT : overrides.failureMemoryDraft,
  }).returning();
  return incident;
}

const instanceAdmin: BoardActor = {
  type: "board",
  source: "session",
  userId: randomUUID(),
  companyIds: [],
  memberships: [],
  isInstanceAdmin: true,
};

describeEmbeddedPostgres("JARVIS-01 promoteIncidentFailureMemoryToCandidate (service level)", () => {
  const actor = { actorType: "user" as const, actorId: "tester", agentId: null, runId: null };

  it("[created] resolved + candidate=true + draft present -> candidate created", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const incident = await seedIncident(db);

    const result = await promoteIncidentFailureMemoryToCandidate(db, company.companyId, incident.id, actor);
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.operation.status).toBe("candidate");
    expect(result.operation.reviewState).toBe("pending");
    expect(result.operation.sourceType).toBe("incident_failure_memory");
    expect(result.operation.sourceId).toBe(incident.id);
  }, 30_000);

  it("[fail-closed] unresolved incident is skipped", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const incident = await seedIncident(db, { status: "open" });

    const result = await promoteIncidentFailureMemoryToCandidate(db, company.companyId, incident.id, actor);
    expect(result).toEqual({ outcome: "skipped", reason: "incident_not_resolved" });
  }, 30_000);

  it("[fail-closed] failureMemoryCandidate=false is skipped", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const incident = await seedIncident(db, { failureMemoryCandidate: false });

    const result = await promoteIncidentFailureMemoryToCandidate(db, company.companyId, incident.id, actor);
    expect(result).toEqual({ outcome: "skipped", reason: "not_failure_memory_candidate" });
  }, 30_000);

  it("[fail-closed] missing failureMemoryDraft is skipped", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const incident = await seedIncident(db, { failureMemoryDraft: null });

    const result = await promoteIncidentFailureMemoryToCandidate(db, company.companyId, incident.id, actor);
    expect(result).toEqual({ outcome: "skipped", reason: "missing_failure_memory_draft" });
  }, 30_000);

  it("[fail-closed] unknown company is skipped", async () => {
    const db = await newTestDb();
    const incident = await seedIncident(db);

    const result = await promoteIncidentFailureMemoryToCandidate(db, randomUUID(), incident.id, actor);
    expect(result).toEqual({ outcome: "skipped", reason: "company_not_found" });
  }, 30_000);

  it("[fail-closed] unknown incident is skipped", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");

    const result = await promoteIncidentFailureMemoryToCandidate(db, company.companyId, randomUUID(), actor);
    expect(result).toEqual({ outcome: "skipped", reason: "incident_not_found" });
  }, 30_000);

  it("[dedup same company] repeated trigger for the same incident+company deduplicates, zero duplicate rows", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const incident = await seedIncident(db);

    const first = await promoteIncidentFailureMemoryToCandidate(db, company.companyId, incident.id, actor);
    const second = await promoteIncidentFailureMemoryToCandidate(db, company.companyId, incident.id, actor);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("deduplicated");
    if (second.outcome !== "deduplicated" || first.outcome !== "created") throw new Error("unreachable");
    expect(second.operation.id).toBe(first.operation.id);

    const rows = await db.select().from(memoryOperations).where(eq(memoryOperations.sourceId, incident.id));
    expect(rows).toHaveLength(1);
  }, 30_000);

  it("[dedup across companies] the SAME incident promoted into a DIFFERENT company also deduplicates globally — proves Option B", async () => {
    const db = await newTestDb();
    const companyA = await seedCompanyWithBoardAccess(db, "FM Co A");
    const companyB = await seedCompanyWithBoardAccess(db, "FM Co B");
    const incident = await seedIncident(db);

    const first = await promoteIncidentFailureMemoryToCandidate(db, companyA.companyId, incident.id, actor);
    const second = await promoteIncidentFailureMemoryToCandidate(db, companyB.companyId, incident.id, actor);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("deduplicated");
    if (second.outcome !== "deduplicated") throw new Error("unreachable");
    // The deduplicated result points back at company A's row — no row was
    // ever created for company B.
    expect(second.operation.companyId).toBe(companyA.companyId);

    const allRows = await db.select().from(memoryOperations).where(eq(memoryOperations.sourceId, incident.id));
    expect(allRows).toHaveLength(1);
    expect(allRows[0]!.companyId).toBe(companyA.companyId);
  }, 30_000);

  it("[tenant data safety] raw draft fields are absent; only the minimum provenance allowlist is stored", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const incident = await seedIncident(db);

    const result = await promoteIncidentFailureMemoryToCandidate(db, company.companyId, incident.id, actor);
    if (result.outcome !== "created") throw new Error("unreachable");

    const metadata = result.operation.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "createdFromFailureMemory",
      "detectedAt",
      "incidentCode",
      "incidentId",
      "incidentSeverity",
      "resolvedAt",
      "sourceType",
    ].sort());
    expect(metadata.incidentId).toBe(incident.id);
    expect(metadata.incidentCode).toBe(incident.code);
    expect(metadata.createdFromFailureMemory).toBe(true);

    // None of the raw draft's sensitive fields appear anywhere in the
    // stored row (metadata or content).
    const serialized = JSON.stringify(result.operation);
    expect(serialized).not.toContain("internal lifecycle detail");
    expect(serialized).not.toContain('"pid":1234');
    expect(serialized).not.toContain("symptoms");
    expect(serialized).not.toContain("recurrencePrevention");
  }, 30_000);
});

describeEmbeddedPostgres("JARVIS-01 POST /instance/incidents/:id/promote-failure-memory (route level)", () => {
  it("[authorization] instance-admin without target-company access is denied (403)", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const incident = await seedIncident(db);
    const adminWithoutCompanyAccess: BoardActor = { ...instanceAdmin, isInstanceAdmin: true, companyIds: [] };

    const app = routeApp(db, adminWithoutCompanyAccess, instanceIncidentRoutes);
    const res = await request(app)
      .post(`/api/instance/incidents/${incident.id}/promote-failure-memory`)
      .send({ companyId: company.companyId });
    expect(res.status).toBe(403);
  }, 30_000);

  it("[authorization] target-company access without instance-admin is denied (403)", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const incident = await seedIncident(db);

    const app = routeApp(db, company.actor, instanceIncidentRoutes);
    const res = await request(app)
      .post(`/api/instance/incidents/${incident.id}/promote-failure-memory`)
      .send({ companyId: company.companyId });
    expect(res.status).toBe(403);
  }, 30_000);

  it("[success] instance-admin WITH target-company access succeeds and creates a pending/unverified candidate", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const incident = await seedIncident(db);
    const adminWithCompanyAccess: BoardActor = {
      ...instanceAdmin,
      companyIds: [company.companyId],
      memberships: [{ companyId: company.companyId, membershipRole: "owner", status: "active" }],
    };

    const app = routeApp(db, adminWithCompanyAccess, instanceIncidentRoutes);
    const res = await request(app)
      .post(`/api/instance/incidents/${incident.id}/promote-failure-memory`)
      .send({ companyId: company.companyId });

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe("created");
    expect(res.body.operation.status).toBe("candidate");
    expect(res.body.operation.reviewState).toBe("pending");
  }, 30_000);

  it("[validation] missing companyId is rejected with 400", async () => {
    const db = await newTestDb();
    const incident = await seedIncident(db);
    const app = routeApp(db, instanceAdmin, instanceIncidentRoutes);
    const res = await request(app).post(`/api/instance/incidents/${incident.id}/promote-failure-memory`).send({});
    expect(res.status).toBe(400);
  }, 30_000);

  it("[not found] unknown incident id returns 404", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const adminWithCompanyAccess: BoardActor = {
      ...instanceAdmin,
      companyIds: [company.companyId],
      memberships: [{ companyId: company.companyId, membershipRole: "owner", status: "active" }],
    };
    const app = routeApp(db, adminWithCompanyAccess, instanceIncidentRoutes);
    const res = await request(app)
      .post(`/api/instance/incidents/${randomUUID()}/promote-failure-memory`)
      .send({ companyId: company.companyId });
    expect(res.status).toBe(404);
  }, 30_000);

  it("[ineligible] unresolved incident returns 409", async () => {
    const db = await newTestDb();
    const company = await seedCompanyWithBoardAccess(db, "FM Co");
    const incident = await seedIncident(db, { status: "open" });
    const adminWithCompanyAccess: BoardActor = {
      ...instanceAdmin,
      companyIds: [company.companyId],
      memberships: [{ companyId: company.companyId, membershipRole: "owner", status: "active" }],
    };
    const app = routeApp(db, adminWithCompanyAccess, instanceIncidentRoutes);
    const res = await request(app)
      .post(`/api/instance/incidents/${incident.id}/promote-failure-memory`)
      .send({ companyId: company.companyId });
    expect(res.status).toBe(409);
  }, 30_000);
});
