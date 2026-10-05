import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { authUsers, boardApiKeys, companies, companySecrets, createDb } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { secretsRegistryRoutes } from "../routes/secrets-registry.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secrets registry HTTP-level tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-secrets-registry-routes-");
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
  app.use("/api", secretsRegistryRoutes(db));
  app.use(errorHandler);
  return app;
}

const USER_ID = "board-user-1";
function boardActor(companyIds: string[]) {
  return { type: "board", userId: USER_ID, source: "session", isInstanceAdmin: false, companyIds };
}
const localImplicitActor = { type: "board", userId: USER_ID, source: "local_implicit", isInstanceAdmin: false };
const agentActor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" };
function boardActorNoUserId(companyIds: string[]) {
  return { type: "board", source: "session", isInstanceAdmin: false, companyIds };
}

describeEmbeddedPostgres("F-02 secrets registry routes (HTTP level, real test DB)", () => {
  it("[route mounted][HTTP 200] GET /api/secrets responds 200 with an empty list for a fresh company", async () => {
    const db = await newTestDb();
    const [company] = await db.insert(companies).values({ name: "Route Test Co" }).returning();
    const res = await request(createApp(db, localImplicitActor)).get("/api/secrets").query({ companyId: company.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [] });
  }, 30_000);

  it("[malformed input] companyId is required — 400 without it", async () => {
    const db = await newTestDb();
    const res = await request(createApp(db, localImplicitActor)).get("/api/secrets");
    expect(res.status).toBe(400);
  }, 30_000);

  it("[malformed input] an invalid type filter is rejected with 400", async () => {
    const db = await newTestDb();
    const [company] = await db.insert(companies).values({ name: "Route Test Co 2" }).returning();
    const res = await request(createApp(db, localImplicitActor))
      .get("/api/secrets")
      .query({ companyId: company.id, type: "not_a_real_type" });
    expect(res.status).toBe(400);
  }, 30_000);

  it("[auth gate] an agent actor cannot call this board-only route", async () => {
    const db = await newTestDb();
    const [company] = await db.insert(companies).values({ name: "Route Test Co 3" }).returning();
    const res = await request(createApp(db, agentActor)).get("/api/secrets").query({ companyId: company.id });
    expect(res.status).toBe(403);
  }, 30_000);

  it("[auth gate] a board actor without companyIds membership for the target company gets 403", async () => {
    const db = await newTestDb();
    const [company] = await db.insert(companies).values({ name: "Route Test Co 4" }).returning();
    const res = await request(createApp(db, boardActor(["some-other-company"])))
      .get("/api/secrets")
      .query({ companyId: company.id });
    expect(res.status).toBe(403);
  }, 30_000);

  it("[auth gate] a board actor with no identifiable userId fails closed (401), never silently scoped to nobody's keys", async () => {
    const db = await newTestDb();
    const [company] = await db.insert(companies).values({ name: "Route Test Co 5" }).returning();
    const res = await request(createApp(db, boardActorNoUserId([company.id])))
      .get("/api/secrets")
      .query({ companyId: company.id });
    expect(res.status).toBe(401);
  }, 30_000);

  it("[wrong company deny][plaintext API leak test] a secret belonging to another company never appears, and no response ever contains plaintext-shaped values", async () => {
    const db = await newTestDb();
    const [companyA] = await db.insert(companies).values({ name: "Owner Co", issuePrefix: "OWN" }).returning();
    const [companyB] = await db.insert(companies).values({ name: "Other Co", issuePrefix: "OTH" }).returning();
    const PLAINTEXT_MARKER = "sk-should-never-leak-1234567890";
    await db.insert(companySecrets).values({
      companyId: companyA.id, scope: "company", key: "SOME_KEY", name: "Some Key",
      status: "active",
      // providerMetadata is a jsonb field the registry never selects for
      // display — this proves it too, in addition to the plaintext marker
      // never being derivable from anything the registry DOES select.
      providerMetadata: { note: PLAINTEXT_MARKER },
    });

    const resOwnCompany = await request(createApp(db, localImplicitActor))
      .get("/api/secrets")
      .query({ companyId: companyA.id });
    expect(resOwnCompany.status).toBe(200);
    expect(JSON.stringify(resOwnCompany.body)).not.toContain(PLAINTEXT_MARKER);

    const resOtherCompany = await request(createApp(db, localImplicitActor))
      .get("/api/secrets")
      .query({ companyId: companyB.id });
    expect(resOtherCompany.status).toBe(200);
    expect(resOtherCompany.body.entries.filter((e: { type: string }) => e.type === "secret")).toHaveLength(0);
  }, 30_000);

  it("[error response] GET /api/secrets/:id returns 404 with an error body for an unknown id, never a plaintext hint", async () => {
    const db = await newTestDb();
    const [company] = await db.insert(companies).values({ name: "Route Test Co 6" }).returning();
    const res = await request(createApp(db, localImplicitActor))
      .get(`/api/secrets/${randomUUID()}`)
      .query({ companyId: company.id });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  }, 30_000);

  it("[wrong user deny] another user's board API key never appears in this user's listing", async () => {
    const db = await newTestDb();
    const [company] = await db.insert(companies).values({ name: "Route Test Co 7" }).returning();
    const now = new Date();
    await db.insert(authUsers).values({ id: "someone-else", name: "Someone Else", email: "someone-else@example.com", createdAt: now, updatedAt: now });
    await db.insert(boardApiKeys).values({ userId: "someone-else", name: "not-mine", keyHash: "z".repeat(24) });
    const res = await request(createApp(db, localImplicitActor)).get("/api/secrets").query({ companyId: company.id });
    expect(res.status).toBe(200);
    expect(res.body.entries.filter((e: { type: string }) => e.type === "board_api_key")).toHaveLength(0);
  }, 30_000);
});
