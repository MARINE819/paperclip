import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, dataLifecyclePolicies } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { dataLifecycleRoutes } from "../routes/data-lifecycle.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping F-01 data-lifecycle HTTP-level tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-data-lifecycle-routes-");
  cleanups.push(testDb.cleanup);
  return createDb(testDb.connectionString);
}

function createApp(db: Awaited<ReturnType<typeof newTestDb>>, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", dataLifecycleRoutes(db));
  app.use(errorHandler);
  return app;
}

const admin = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true };
const nonAdmin = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: ["c1"] };

describeEmbeddedPostgres("F-01 data-lifecycle routes (HTTP level, real test DB, READ-ONLY)", () => {
  it("[route mounted][HTTP 200] GET /api/data-lifecycle/policies responds 200 with an empty list before anything exists", async () => {
    const db = await newTestDb();
    const res = await request(createApp(db, admin)).get("/api/data-lifecycle/policies");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ policies: [] });
  }, 30_000);

  it("[auth gate] non-admin -> 403 on all three GET endpoints", async () => {
    const db = await newTestDb();
    const app = createApp(db, nonAdmin);
    await request(app).get("/api/data-lifecycle/policies").expect(403);
    await request(app).get("/api/data-lifecycle/summary").expect(403);
    await request(app).get("/api/data-lifecycle/dry-run").query({ dataClass: "audit" }).expect(403);
  }, 30_000);

  it("[summary] lists all 12 recognized data classes, each with a classification and a null policy when unconfigured", async () => {
    const db = await newTestDb();
    const res = await request(createApp(db, admin)).get("/api/data-lifecycle/summary");
    expect(res.status).toBe(200);
    expect(res.body.classifications).toHaveLength(12);
    const memorySummary = res.body.classifications.find((c: { dataClass: string }) => c.dataClass === "memory_summary");
    expect(memorySummary.status).toBe("unmapped");
    expect(memorySummary.policy).toBeNull();
    const backupMetadata = res.body.classifications.find((c: { dataClass: string }) => c.dataClass === "backup_metadata");
    expect(backupMetadata.status).toBe("file_based");
  }, 30_000);

  it("[dry-run malformed input] a missing/invalid dataClass is rejected with 400, never silently defaulted", async () => {
    const db = await newTestDb();
    const app = createApp(db, admin);
    await request(app).get("/api/data-lifecycle/dry-run").expect(400);
    await request(app).get("/api/data-lifecycle/dry-run").query({ dataClass: "not_a_real_class" }).expect(400);
  }, 30_000);

  it("[dry-run fail-closed via HTTP] no configured policy -> 200 with reason=no_policy_configured, zero candidates", async () => {
    const db = await newTestDb();
    const res = await request(createApp(db, admin))
      .get("/api/data-lifecycle/dry-run")
      .query({ dataClass: "audit" });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ reason: "no_policy_configured", candidateCount: 0, action: "none" });
  }, 30_000);

  it("[policies reflect configured rows] GET /api/data-lifecycle/policies returns an inserted policy row verbatim", async () => {
    const db = await newTestDb();
    await db.insert(dataLifecyclePolicies).values({
      dataClass: "audit",
      retentionMode: "delete",
      retentionDays: 90,
      enabled: true,
    });
    const res = await request(createApp(db, admin)).get("/api/data-lifecycle/policies");
    expect(res.status).toBe(200);
    expect(res.body.policies).toHaveLength(1);
    expect(res.body.policies[0]).toMatchObject({ dataClass: "audit", retentionMode: "delete", retentionDays: 90, enabled: true });
  }, 30_000);
});
