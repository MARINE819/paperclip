import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

// F-01 Data Lifecycle batch — CEO-required regression check ("기존
// activity_log soft archive / hard delete 정책 회귀 검증"). This does NOT
// modify companies.ts. It only asserts the pre-existing, already-shipped
// behavior this batch's data classification depends on (activity_log's
// notes state it is "append-only by design — no archivedAt/deletedAt
// column"): companyService.archive() is a soft state change that leaves
// activity_log alone, and companyService.remove() is the one real hard
// delete path and does cascade-delete activity_log. If either regresses,
// F-01's "audit" class classification notes become false.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping F-01 companies activity_log regression tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-data-lifecycle-company-regression-");
  cleanups.push(testDb.cleanup);
  return createDb(testDb.connectionString);
}

describeEmbeddedPostgres("F-01 regression: companyService archive()/remove() vs activity_log (companies.ts untouched)", () => {
  it("[soft archive] archive() flips status to archived but leaves pre-existing activity_log rows in place", async () => {
    const db = await newTestDb();
    const company = await companyService(db).create({ name: "Archive Regression Co" });
    await db.insert(activityLog).values({
      companyId: company.id,
      actorId: "system",
      action: "pre.existing.event",
      entityType: "test",
      entityId: "e1",
    });

    const beforeCount = (await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).length;
    const archived = await companyService(db).archive(company.id);
    expect(archived?.status).toBe("archived");

    const afterRows = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    // archive() itself appends a "company.archived" activity entry — so the
    // count must be at least the pre-existing rows, never fewer.
    expect(afterRows.length).toBeGreaterThanOrEqual(beforeCount);
    expect(afterRows.some((r) => r.action === "pre.existing.event")).toBe(true);
  }, 30_000);

  it("[hard delete] remove() cascade-deletes every activity_log row for the company", async () => {
    const db = await newTestDb();
    const company = await companyService(db).create({ name: "Remove Regression Co" });
    await db.insert(activityLog).values({
      companyId: company.id,
      actorId: "system",
      action: "pre.existing.event",
      entityType: "test",
      entityId: "e1",
    });

    const beforeRows = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    expect(beforeRows.length).toBeGreaterThan(0);

    await companyService(db).remove(company.id);

    const afterRows = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    expect(afterRows).toHaveLength(0);
    const companyRows = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(companyRows).toHaveLength(0);
  }, 30_000);
});
