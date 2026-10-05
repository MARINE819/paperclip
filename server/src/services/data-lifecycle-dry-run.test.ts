import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, dataLifecyclePolicies, knowledgeRecords, secretAccessEvents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { computeDryRun } from "./data-lifecycle-dry-run.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping F-01 data-lifecycle-dry-run integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-data-lifecycle-");
  cleanups.push(testDb.cleanup);
  return createDb(testDb.connectionString);
}

async function seedCompany(db: Db) {
  const [company] = await db
    .insert(companies)
    .values({ name: `Lifecycle Test Co ${randomUUID()}`, issuePrefix: randomUUID().slice(0, 8).toUpperCase() })
    .returning();
  return company;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function seedActivityLogRow(db: Db, companyId: string, createdAt: Date) {
  await db.insert(activityLog).values({
    companyId,
    actorId: "system",
    action: "test.event",
    entityType: "test",
    entityId: randomUUID(),
    createdAt,
  });
}

async function seedKnowledgeRecordRow(db: Db, companyId: string, createdAt: Date) {
  await db.insert(knowledgeRecords).values({
    companyId,
    title: `K ${randomUUID()}`,
    body: "body",
    createdAt,
  });
}

async function seedSecretAccessEventRow(db: Db, companyId: string, createdAt: Date) {
  await db.insert(secretAccessEvents).values({
    companyId,
    provider: "test",
    actorType: "system",
    consumerType: "heartbeat",
    consumerId: randomUUID(),
    outcome: "granted",
    createdAt,
  });
}

describeEmbeddedPostgres("F-01 data-lifecycle dry-run engine (isolated test DB, ZERO mutation)", () => {
  it("[fail-closed] policy-less data is never flagged as a candidate", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedActivityLogRow(db, company.id, daysAgo(9999));

    const result = await computeDryRun(db, "audit");
    expect(result.reason).toBe("no_policy_configured");
    expect(result.action).toBe("none");
    expect(result.candidateCount).toBe(0);
  }, 30_000);

  it("[fail-closed] a disabled policy never produces candidates even with matching old rows", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedActivityLogRow(db, company.id, daysAgo(9999));
    await db.insert(dataLifecyclePolicies).values({
      dataClass: "audit",
      retentionMode: "delete",
      retentionDays: 30,
      enabled: false,
    });

    const result = await computeDryRun(db, "audit");
    expect(result.reason).toBe("policy_disabled");
    expect(result.candidateCount).toBe(0);
  }, 30_000);

  it("[fail-closed] legal hold blocks candidacy even when enabled with a matching retention window", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedActivityLogRow(db, company.id, daysAgo(9999));
    await db.insert(dataLifecyclePolicies).values({
      dataClass: "audit",
      retentionMode: "delete",
      retentionDays: 30,
      enabled: true,
      legalHold: true,
    });

    const result = await computeDryRun(db, "audit");
    expect(result.reason).toBe("legal_hold_active");
    expect(result.candidateCount).toBe(0);
  }, 30_000);

  it("[fail-closed] retentionMode=retain never produces candidates regardless of age", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedActivityLogRow(db, company.id, daysAgo(9999));
    await db.insert(dataLifecyclePolicies).values({
      dataClass: "audit",
      retentionMode: "retain",
      enabled: true,
    });

    const result = await computeDryRun(db, "audit");
    expect(result.reason).toBe("retention_mode_retain");
    expect(result.candidateCount).toBe(0);
  }, 30_000);

  it("[fail-closed] an enabled archive/delete policy with no retentionDays configured blocks rather than guessing", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedActivityLogRow(db, company.id, daysAgo(9999));
    await db.insert(dataLifecyclePolicies).values({
      dataClass: "audit",
      retentionMode: "delete",
      retentionDays: null,
      enabled: true,
    });

    const result = await computeDryRun(db, "audit");
    expect(result.reason).toBe("invalid_retention_days");
    expect(result.candidateCount).toBe(0);
  }, 30_000);

  it("[retention boundary] only rows strictly older than the cutoff are counted as candidates", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedActivityLogRow(db, company.id, daysAgo(40)); // older than 30d cutoff
    await seedActivityLogRow(db, company.id, daysAgo(35)); // older than 30d cutoff
    await seedActivityLogRow(db, company.id, daysAgo(10)); // newer than cutoff — must NOT be counted
    await db.insert(dataLifecyclePolicies).values({
      dataClass: "audit",
      retentionMode: "delete",
      retentionDays: 30,
      enabled: true,
    });

    const result = await computeDryRun(db, "audit");
    expect(result.reason).toBe("ok");
    expect(result.action).toBe("delete");
    expect(result.candidateCount).toBe(2);
    expect(result.oldestCandidate).not.toBeNull();
    expect(result.newestCandidate).not.toBeNull();
  }, 30_000);

  it("[archive vs delete] action reflects the configured retentionMode, not a hardcoded default", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedActivityLogRow(db, company.id, daysAgo(100));
    await db.insert(dataLifecyclePolicies).values({
      dataClass: "audit",
      retentionMode: "archive",
      retentionDays: 30,
      enabled: true,
    });

    const result = await computeDryRun(db, "audit");
    expect(result.action).toBe("archive");
    expect(result.candidateCount).toBe(1);
  }, 30_000);

  it("[two-stage] archive_then_delete reports the archive stage (archiveAfterDays), not hardDeleteAfterDays", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedActivityLogRow(db, company.id, daysAgo(20)); // older than archiveAfterDays(15) but newer than hardDeleteAfterDays(60)
    await db.insert(dataLifecyclePolicies).values({
      dataClass: "audit",
      retentionMode: "archive_then_delete",
      archiveAfterDays: 15,
      hardDeleteAfterDays: 60,
      enabled: true,
    });

    const result = await computeDryRun(db, "audit");
    expect(result.action).toBe("archive_then_delete");
    expect(result.candidateCount).toBe(1);
  }, 30_000);

  it("[verified-knowledge protection] knowledge_records with no configured policy is never a candidate", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedKnowledgeRecordRow(db, company.id, daysAgo(9999));

    const result = await computeDryRun(db, "verified_knowledge");
    expect(result.reason).toBe("no_policy_configured");
    expect(result.candidateCount).toBe(0);
  }, 30_000);

  it("[audit protection] secret_audit (secret_access_events) with no configured policy is never a candidate", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedSecretAccessEventRow(db, company.id, daysAgo(9999));

    const result = await computeDryRun(db, "secret_audit");
    expect(result.reason).toBe("no_policy_configured");
    expect(result.candidateCount).toBe(0);
  }, 30_000);

  it("[no forced mapping] memory_summary reports unsupported_data_class, never a fake table", async () => {
    const db = await newTestDb();
    const result = await computeDryRun(db, "memory_summary");
    expect(result.reason).toBe("unsupported_data_class");
    expect(result.candidateCount).toBe(0);
    expect(result.source).toBe("none");
  }, 30_000);

  it("[zero mutation] computing a dry-run does not change row counts, and running it twice is idempotent", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await seedActivityLogRow(db, company.id, daysAgo(100));
    await seedActivityLogRow(db, company.id, daysAgo(200));
    await db.insert(dataLifecyclePolicies).values({
      dataClass: "audit",
      retentionMode: "delete",
      retentionDays: 30,
      enabled: true,
    });

    const before = await db.select().from(activityLog);
    const first = await computeDryRun(db, "audit");
    const second = await computeDryRun(db, "audit");
    const after = await db.select().from(activityLog);

    expect(after).toHaveLength(before.length);
    expect(second).toEqual(first);
  }, 30_000);

  it("[backup_metadata] read-only filesystem dry-run counts old backup files without deleting them", async () => {
    const db = await newTestDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexora-f01-backup-dryrun-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const oldFile = path.join(dir, "old.sql.gz");
    const newFile = path.join(dir, "new.sql.gz");
    fs.writeFileSync(oldFile, "fake");
    fs.writeFileSync(newFile, "fake");
    const oldTime = daysAgo(40);
    const newTime = daysAgo(1);
    fs.utimesSync(oldFile, oldTime, oldTime);
    fs.utimesSync(newFile, newTime, newTime);

    await db.insert(dataLifecyclePolicies).values({
      dataClass: "backup_metadata",
      retentionMode: "delete",
      retentionDays: 30,
      enabled: true,
    });

    const result = await computeDryRun(db, "backup_metadata", { backupDir: dir });
    expect(result.reason).toBe("ok");
    expect(result.candidateCount).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(true);
    expect(fs.existsSync(newFile)).toBe(true);
  }, 30_000);
});
