import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, plugins } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { toolTrustRegistryRoutes } from "../routes/tool-trust-registry.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping tool trust registry HTTP-level tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-trust-routes-");
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
  app.use("/api", toolTrustRegistryRoutes(db));
  app.use(errorHandler);
  return app;
}

const admin = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true };
const localImplicit = { type: "board", userId: "local", source: "local_implicit", isInstanceAdmin: false };
const nonAdmin = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: ["c1"] };

describeEmbeddedPostgres("F-05 tool trust registry routes (HTTP level, real test DB)", () => {
  it("[route mounted][HTTP 200] GET /api/tools/trust-registry responds 200 with an empty list before anything exists", async () => {
    const db = await newTestDb();
    const res = await request(createApp(db, admin)).get("/api/tools/trust-registry");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [] });
  }, 30_000);

  it("[auth gate] non-admin session -> 403; local_implicit -> 200", async () => {
    const db = await newTestDb();
    await request(createApp(db, nonAdmin)).get("/api/tools/trust-registry").expect(403);
    await request(createApp(db, localImplicit)).get("/api/tools/trust-registry").expect(200);
  }, 30_000);

  it("[malformed input] an invalid type/trustStatus query param is rejected with 400", async () => {
    const db = await newTestDb();
    const app = createApp(db, admin);
    await request(app).get("/api/tools/trust-registry").query({ type: "not_a_real_type" }).expect(400);
    await request(app).get("/api/tools/trust-registry").query({ trustStatus: "super_trusted" }).expect(400);
  }, 30_000);

  it("[error response] GET /api/tools/trust-registry/:id returns 404 for an unknown id", async () => {
    const db = await newTestDb();
    const res = await request(createApp(db, admin)).get("/api/tools/trust-registry/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  }, 30_000);

  it("[plugin trust][malformed input] POST review requires trustStatus and reviewedByUserId (a human), 400 otherwise", async () => {
    const db = await newTestDb();
    const app = createApp(db, admin);
    const [plugin] = await db
      .insert(plugins)
      .values({ pluginKey: "route-test-plugin", packageName: "@test/route-plugin", version: "1.0.0", manifestJson: {} as never })
      .returning();

    await request(app).post(`/api/tools/trust-registry/plugins/${plugin.id}/review`).send({}).expect(400);
    await request(app)
      .post(`/api/tools/trust-registry/plugins/${plugin.id}/review`)
      .send({ trustStatus: "trusted" }) // missing reviewedByUserId
      .expect(400);
    await request(app)
      .post(`/api/tools/trust-registry/plugins/${plugin.id}/review`)
      .send({ trustStatus: "not_a_real_status", reviewedByUserId: "admin" })
      .expect(400);
  }, 30_000);

  it("[plugin trust] a full end-to-end review round-trips through GET /api/tools/trust-registry/:id", async () => {
    const db = await newTestDb();
    const app = createApp(db, admin);
    const [plugin] = await db
      .insert(plugins)
      .values({ pluginKey: "route-test-plugin-2", packageName: "@test/route-plugin-2", version: "1.0.0", manifestJson: {} as never })
      .returning();

    const reviewRes = await request(app)
      .post(`/api/tools/trust-registry/plugins/${plugin.id}/review`)
      .send({ trustStatus: "trusted", riskLevel: "low", approvedScopes: ["read:files"], reviewedByUserId: "human-admin" });
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.entry.trustStatus).toBe("trusted");

    const getRes = await request(app).get(`/api/tools/trust-registry/${plugin.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.entry.trustStatus).toBe("trusted");
    expect(getRes.body.entry.reviewedBy).toBe("human-admin");
    expect(getRes.body.entry.type).toBe("plugin");
  }, 30_000);

  it("[plugin trust][error response] reviewing a non-existent plugin returns 404", async () => {
    const db = await newTestDb();
    const res = await request(createApp(db, admin))
      .post("/api/tools/trust-registry/plugins/00000000-0000-0000-0000-000000000000/review")
      .send({ trustStatus: "trusted", reviewedByUserId: "admin" });
    expect(res.status).toBe(404);
  }, 30_000);
});
