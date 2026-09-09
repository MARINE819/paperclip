import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  issues,
  knowledgeRecords,
  memoryOperations,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { knowledgeRoutes } from "../routes/knowledge.js";
import { inspectKnowledgeRecordLockChains } from "../services/knowledge-record-lock.js";
import type { KnowledgeServiceOptions } from "../services/knowledge.js";
import { syncKnowledgeRecordToObsidian } from "../services/obsidian-sync.js";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

/**
 * Phase 2.3: proves that Obsidian sync for the SAME Knowledge Record is
 * serialized, that DIFFERENT records are not, and that the lock always
 * releases (including after a thrown exception). Every ordering assertion
 * here is driven by explicit deferreds/promise chaining — never by
 * `setTimeout`/sleep — so a broken lock fails deterministically rather than
 * flakily.
 */

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function buildApp(db: Db, actor: BoardActor, vaultRoot: string, obsidianSyncFn?: KnowledgeServiceOptions["obsidianSyncFn"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", knowledgeRoutes(db, { obsidianVaultRoot: vaultRoot, obsidianSyncFn }));
  app.use(errorHandler);
  return app;
}

async function resetFixtures(db: Db) {
  await db.delete(activityLog);
  await db.delete(knowledgeRecords);
  await db.delete(memoryOperations);
  await db.delete(issues);
  await db.delete(agents);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}

async function mkVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "paperclip-obsidian-concurrency-"));
}

async function rmDir(dir: string | null | undefined) {
  if (!dir) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function insertApprovedKnowledgeCandidate(db: Db, companyId: string, title = "Sync target") {
  const [op] = await db.insert(memoryOperations).values({
    companyId,
    sourceType: "issue",
    sourceId: "issue-ref",
    content: "Body v1",
    status: "candidate",
    reviewState: "approved",
    title,
  }).returning();
  const [record] = await db.insert(knowledgeRecords).values({
    companyId,
    title,
    summary: null,
    body: "Body v1",
    sourceMemoryOperationId: op.id,
  }).returning();
  return record;
}

async function allTempFilesUnderVault(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.includes(".tmp")) found.push(full);
    }
  }
  await walk(root);
  return found;
}

describeEmbeddedPostgres("obsidian sync concurrency (per-record serialization)", () => {
  const ctx = useEmbeddedPostgres("paperclip-obsidian-sync-concurrency-", { resetEach: resetFixtures });
  let vaultRoot = "";

  afterEach(async () => {
    await rmDir(vaultRoot);
    vaultRoot = "";
  });

  async function freshVault() {
    vaultRoot = await mkVault();
    return vaultRoot;
  }

  it("[1] serializes two concurrent successful sync requests for the same record", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Concurrency Co");
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId);

    const events: string[] = [];
    const gate1 = deferred<void>();
    const invocation1Started = deferred<void>();
    let invocationCount = 0;
    const obsidianSyncFn: KnowledgeServiceOptions["obsidianSyncFn"] = async (vault, rec) => {
      const invocation = ++invocationCount;
      events.push(`${invocation}-start`);
      if (invocation === 1) {
        invocation1Started.resolve();
        await gate1.promise; // held open by the test so invocation 2's real HTTP/DB
        // round trip has every opportunity to reach the lock while 1 is still busy.
      }
      const outcome = await syncKnowledgeRecordToObsidian(vault, rec);
      events.push(`${invocation}-end`);
      return outcome;
    };

    const app = buildApp(ctx.db, company.actor, root, obsidianSyncFn);
    const p1 = request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({}).then((r) => r);
    const p2 = request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({}).then((r) => r);

    // Deterministic — no tick-counting: wait for the fact of invocation 1
    // actually starting (real Postgres round trips take an unpredictable
    // number of event-loop turns, so a fixed number of `setImmediate` calls
    // is not a reliable substitute for this signal).
    await invocation1Started.promise;
    gate1.resolve();
    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.obsidianSyncState).toBe("synced");
    expect(res2.body.obsidianSyncState).toBe("synced");
    // Whichever request became invocation 1 must have fully finished before
    // invocation 2 started — no interleaving, regardless of which physical
    // HTTP response ended up being invocation 1 vs 2.
    expect(events).toEqual(["1-start", "1-end", "2-start", "2-end"]);

    // Same record, same content either way: both responses report the same path.
    expect(res1.body.obsidianPath).toBe(res2.body.obsidianPath);
    const filePath = path.join(root, res1.body.obsidianPath);
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("Body v1");

    const tempFiles = await allTempFilesUnderVault(root);
    expect(tempFiles).toHaveLength(0);

    const [dbRow] = await ctx.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, record.id));
    expect(dbRow.obsidianSyncState).toBe("synced");

    // Every genuinely successful sync call is its own auditable mutation
    // (each one really wrote the file and advanced obsidianSyncedAt), so
    // both calls are logged — see the activity log policy note below.
    const logged = await ctx.db.select().from(activityLog)
      .where(eq(activityLog.action, "knowledge_record.obsidian_synced"));
    expect(logged).toHaveLength(2);
  });

  it("[1b] logs one activity entry per successful call even when content is byte-identical each time", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Concurrency Co");
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId);
    const app = buildApp(ctx.db, company.actor, root);

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({}).then((r) => r);
      expect(res.status).toBe(200);
      expect(res.body.obsidianSyncState).toBe("synced");
    }

    const logged = await ctx.db.select().from(activityLog)
      .where(eq(activityLog.action, "knowledge_record.obsidian_synced"));
    // Policy (see doc/obsidian-knowledge-sync.md): every successful sync
    // attempt performs a real write and advances obsidianSyncedAt, so it is
    // logged every time — unlike promotion's replay guard, there is no
    // "nothing actually happened" case to collapse here.
    expect(logged).toHaveLength(3);
  });

  it("[2] a failing and a succeeding concurrent request for the same record: final state matches whichever ran last, and the failure never logs", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Concurrency Co");

    // An unrelated, already-synced good record, used to prove a same-tick
    // failure elsewhere cannot corrupt it.
    const unrelatedGood = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId, "Unrelated good record");
    const warmApp = buildApp(ctx.db, company.actor, root);
    const warmRes = await request(warmApp).post(`/api/knowledge-records/${unrelatedGood.id}/obsidian-sync`).send({}).then((r) => r);
    expect(warmRes.status).toBe(200);
    const unrelatedFilePath = path.join(root, warmRes.body.obsidianPath);
    const unrelatedContentBefore = await fs.readFile(unrelatedFilePath, "utf8");

    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId, "Racing record");
    const gate1 = deferred<void>();
    const invocation1Started = deferred<void>();
    let invocationCount = 0;
    const obsidianSyncFn: KnowledgeServiceOptions["obsidianSyncFn"] = async (vault, rec) => {
      const invocation = ++invocationCount;
      if (invocation === 1) {
        invocation1Started.resolve();
        await gate1.promise;
        return { state: "failed", error: "injected failure for test" };
      }
      return syncKnowledgeRecordToObsidian(vault, rec);
    };

    const app = buildApp(ctx.db, company.actor, root, obsidianSyncFn);
    const p1 = request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({}).then((r) => r);
    const p2 = request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({}).then((r) => r);
    await invocation1Started.promise;
    gate1.resolve();
    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Invocation 1 (forced failure) ran first, invocation 2 (real success)
    // ran last — which physical HTTP response ends up as invocation 1 vs 2
    // depends on real request scheduling, so assert on outcome, not on the
    // res1/res2 variable identity.
    const outcomes = [res1.body.obsidianSyncState, res2.body.obsidianSyncState].sort();
    expect(outcomes).toEqual(["failed", "synced"]);

    const [finalRow] = await ctx.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, record.id));
    expect(finalRow.obsidianSyncState).toBe("synced");
    expect(finalRow.obsidianSyncError).toBeNull();

    const unrelatedContentAfter = await fs.readFile(unrelatedFilePath, "utf8");
    expect(unrelatedContentAfter).toBe(unrelatedContentBefore);

    const tempFiles = await allTempFilesUnderVault(root);
    expect(tempFiles).toHaveLength(0);

    const logged = await ctx.db.select().from(activityLog)
      .where(eq(activityLog.action, "knowledge_record.obsidian_synced"));
    // One for the earlier "warm" sync of the unrelated record, one for this
    // record's successful invocation 2. The failed invocation 1 logs nothing.
    expect(logged).toHaveLength(2);
  });

  it("[2b] same cross, opposite order: success then a trailing failure must not corrupt the file it just wrote", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Concurrency Co");
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId, "Racing record 2");

    const gate1 = deferred<void>();
    const invocation1Started = deferred<void>();
    let invocationCount = 0;
    const obsidianSyncFn: KnowledgeServiceOptions["obsidianSyncFn"] = async (vault, rec) => {
      const invocation = ++invocationCount;
      if (invocation === 1) {
        invocation1Started.resolve();
        await gate1.promise;
        return syncKnowledgeRecordToObsidian(vault, rec);
      }
      return { state: "failed", error: "injected failure for test" };
    };

    const app = buildApp(ctx.db, company.actor, root, obsidianSyncFn);
    const p1 = request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({}).then((r) => r);
    const p2 = request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({}).then((r) => r);
    await invocation1Started.promise;
    gate1.resolve();
    const [res1, res2] = await Promise.all([p1, p2]);

    const outcomes = [res1.body.obsidianSyncState, res2.body.obsidianSyncState].sort();
    expect(outcomes).toEqual(["failed", "synced"]);

    const [finalRow] = await ctx.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, record.id));
    // Final state matches the LAST processed call (the failure) for the
    // status columns, but the file the successful invocation wrote must
    // still be intact on disk.
    expect(finalRow.obsidianSyncState).toBe("failed");
    expect(finalRow.obsidianPath).toBeTruthy();
    const filePath = path.join(root, finalRow.obsidianPath as string);
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("Body v1");

    const tempFiles = await allTempFilesUnderVault(root);
    expect(tempFiles).toHaveLength(0);
  });

  it("[3] a thrown exception on the first call releases the lock; the second call completes without hanging", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Concurrency Co");
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId);

    let invocationCount = 0;
    const obsidianSyncFn: KnowledgeServiceOptions["obsidianSyncFn"] = async (vault, rec) => {
      const invocation = ++invocationCount;
      if (invocation === 1) {
        throw new Error("unexpected crash");
      }
      return syncKnowledgeRecordToObsidian(vault, rec);
    };

    const app = buildApp(ctx.db, company.actor, root, obsidianSyncFn);
    const [res1, res2] = await Promise.all([
      request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({}),
      request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({}),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    // One request surfaces the crash as a server error, the other completes
    // the sync normally — in either order.
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(500);

    const successRes = res1.status === 200 ? res1 : res2;
    expect(successRes.body.obsidianSyncState).toBe("synced");

    expect(inspectKnowledgeRecordLockChains().has(`${company.companyId}:${record.id}`)).toBe(false);
  });

  it("[4] concurrent syncs for two different records do not wait on each other", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Concurrency Co");
    const recordA = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId, "Record A");
    const recordB = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId, "Record B");

    const events: string[] = [];
    const gateA = deferred<void>();
    const obsidianSyncFn: KnowledgeServiceOptions["obsidianSyncFn"] = async (vault, rec) => {
      if (rec.id === recordA.id) {
        events.push("A-start");
        await gateA.promise;
        const outcome = await syncKnowledgeRecordToObsidian(vault, rec);
        events.push("A-end");
        return outcome;
      }
      events.push("B-start");
      const outcome = await syncKnowledgeRecordToObsidian(vault, rec);
      events.push("B-end");
      return outcome;
    };

    const app = buildApp(ctx.db, company.actor, root, obsidianSyncFn);
    const pA = request(app).post(`/api/knowledge-records/${recordA.id}/obsidian-sync`).send({}).then((r) => r);
    const pB = request(app).post(`/api/knowledge-records/${recordB.id}/obsidian-sync`).send({}).then((r) => r);

    // Record B must be able to finish completely while record A's gate is
    // still closed — proving there is no global serialization. The relative
    // order of "A-start" against B's events is genuinely racy (A and B are
    // unrelated, independent requests) and is not asserted; what matters is
    // that B reaches "B-end" without ever waiting for gateA.
    const resB = await pB;
    expect(resB.status).toBe(200);
    expect(events).toContain("B-start");
    expect(events).toContain("B-end");
    expect(events).not.toContain("A-end");

    gateA.resolve();
    const resA = await pA;
    expect(resA.status).toBe(200);
    // A's "-start" ordering against B's events is racy (asserted above only
    // as "not yet finished"); what's deterministic is that A cannot reach
    // "A-end" until after this point, since gateA was held closed until
    // after B fully completed. Assert the fixed part (all four events
    // occurred exactly once, A-end is last) without asserting the racy part
    // (A-start vs B-start relative order).
    expect(events).toHaveLength(4);
    expect(new Set(events)).toEqual(new Set(["A-start", "B-start", "B-end", "A-end"]));
    expect(events[events.length - 1]).toBe("A-end");
  });

  it("[5] the lock map is empty after many records have been synced", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Concurrency Co");
    const app = buildApp(ctx.db, company.actor, root);

    const records = await Promise.all(
      Array.from({ length: 5 }, (_, i) => insertApprovedKnowledgeCandidate(ctx.db, company.companyId, `Bulk ${i}`)),
    );
    await Promise.all(
      records.map((record) => request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({})),
    );

    expect(inspectKnowledgeRecordLockChains().size).toBe(0);
  });
});
