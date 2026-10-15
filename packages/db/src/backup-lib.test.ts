import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import {
  createBufferedTextFileWriter,
  runDatabaseBackup,
  runDatabaseRestore,
  queryRestoreJournalEntry,
  canonicalBackupDirKey,
  withBackupDirLock,
  GzipFinalizeTimeoutError,
  type BackupLifecycleEvent,
} from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("canonicalBackupDirKey", () => {
  it("creates the directory if missing and returns its realpath-based canonical form", () => {
    const parent = createTempDir("paperclip-db-canonical-");
    const nested = path.join(parent, "nested", "backups");
    expect(fs.existsSync(nested)).toBe(false);

    const key = canonicalBackupDirKey(nested);

    expect(fs.existsSync(nested)).toBe(true);
    const realKey = fs.realpathSync(nested);
    expect(key).toBe(process.platform === "win32" ? realKey.toLowerCase() : realKey);
  });

  it("normalizes the canonical key to lowercase when process.platform is mocked as win32", () => {
    const dir = createTempDir("paperclip-db-canonical-win32-");
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const key = canonicalBackupDirKey(dir);
      expect(key).toBe(fs.realpathSync(dir).toLowerCase());
    } finally {
      Object.defineProperty(process, "platform", originalDescriptor);
    }
  });

  it("fails closed (throws, never silently proceeds) for a path Node cannot resolve", () => {
    expect(() => canonicalBackupDirKey("invalid\0path")).toThrow();
  });
});

describe("withBackupDirLock", () => {
  it("serializes calls for the same key in FIFO order", async () => {
    const dir = createTempDir("paperclip-db-mutex-fifo-");
    const order: string[] = [];
    const first = createDeferred<void>();
    const second = createDeferred<void>();

    const callA = withBackupDirLock(dir, async () => {
      order.push("A-start");
      await first.promise;
      order.push("A-end");
    });
    const callB = withBackupDirLock(dir, async () => {
      order.push("B-start");
      await second.promise;
      order.push("B-end");
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["A-start"]);

    first.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["A-start", "A-end", "B-start"]);

    second.resolve();
    await Promise.all([callA, callB]);
    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  it("lets a queued call proceed even though the call ahead of it rejects", async () => {
    const dir = createTempDir("paperclip-db-mutex-failure-queue-");
    const firstError = new Error("intentional failure");
    const gate = createDeferred<void>();

    const firstCall = withBackupDirLock(dir, async () => {
      await gate.promise;
      throw firstError;
    });
    const secondCall = withBackupDirLock(dir, async () => "second-ran");

    gate.resolve();
    await expect(firstCall).rejects.toBe(firstError);
    await expect(secondCall).resolves.toBe("second-ran");
  });

  it("rejects immediately on reentrant calls for the same key without hanging", async () => {
    const dir = createTempDir("paperclip-db-mutex-reentrant-");
    const outer = withBackupDirLock(dir, async () => {
      return withBackupDirLock(dir, async () => "should not run");
    });
    await expect(outer).rejects.toThrow(/Reentrant withBackupDirLock/);
  }, 5_000);

  it("does not block a different backupDir key while one key's lock is held", async () => {
    const dirA = createTempDir("paperclip-db-mutex-independent-a-");
    const dirB = createTempDir("paperclip-db-mutex-independent-b-");
    const gate = createDeferred<void>();

    const heldA = withBackupDirLock(dirA, async () => {
      await gate.promise;
      return "A-done";
    });
    const quickB = await withBackupDirLock(dirB, async () => "B-done");
    expect(quickB).toBe("B-done");

    gate.resolve();
    await expect(heldA).resolves.toBe("A-done");
  });
});

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

const createSpecialValuesSql = `
  CREATE TABLE "public"."copy_special_values" (
    "id" uuid PRIMARY KEY,
    "note" text
  );
  INSERT INTO "public"."copy_special_values" ("id", "note") VALUES
    ('11111111-1111-4111-8111-111111111111', NULL),
    ('22222222-2222-4222-8222-222222222222', 'tab\there'),
    ('33333333-3333-4333-8333-333333333333', 'line one\nline two'),
    ('44444444-4444-4444-8444-444444444444', 'back\\slash'),
    ('55555555-5555-4555-8555-555555555555', '한글 데이터');
`;

const selectSpecialValuesSql = `
  SELECT "id", "note" FROM "public"."copy_special_values" ORDER BY "id"
`;

const expectedSpecialValueRows = [
  { id: "11111111-1111-4111-8111-111111111111", note: null },
  { id: "22222222-2222-4222-8222-222222222222", note: "tab\there" },
  { id: "33333333-3333-4333-8333-333333333333", note: "line one\nline two" },
  { id: "44444444-4444-4444-8444-444444444444", note: "back\\slash" },
  { id: "55555555-5555-4555-8555-555555555555", note: "한글 데이터" },
];

const createCopyThenSqlSql = `
  CREATE TABLE "public"."copy_then_sql" (
    "id" bigserial PRIMARY KEY,
    "note" text NOT NULL
  );
  INSERT INTO "public"."copy_then_sql" ("note")
  VALUES ('first'), ('second'), ('third');
`;

const copyThenSqlCopyHeaderMarker = 'COPY "public"."copy_then_sql"';

const selectCopyThenSqlSql = `
  SELECT "note" FROM "public"."copy_then_sql" ORDER BY "id"
`;

const expectedCopyThenSqlRows = [
  { note: "first" },
  { note: "second" },
  { note: "third" },
];

const insertCopyThenSqlSql = `
  INSERT INTO "public"."copy_then_sql" ("note")
  VALUES ('fourth')
  RETURNING "id", "note"
`;

const malformedCopyHeaderBackupLines = [
  "-- Paperclip database backup",
  "-- Created: 2026-04-06T00:00:00.000Z",
  "",
  "BEGIN;",
  "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
  "CREATE TABLE public.malformed_copy_test (",
  "  id integer primary key,",
  "  payload text not null",
  ");",
  "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
  'COPY "public"."malformed_copy_test (id, payload) FROM stdin;',
  "1\tbad",
  "\\.",
  "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
  "COMMIT;",
  "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
];

const malformedCopyHeaderBackupText = malformedCopyHeaderBackupLines.join("\n");

const selectMalformedCopyTestTableSql = `
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'malformed_copy_test'
`;

const SANDBOX_UAT_ITEM_COUNT = 3000;

const createSandboxUatSchemaSql = `
  CREATE SCHEMA "sandbox_uat";
  CREATE TYPE "sandbox_uat"."item_status"
    AS ENUM ('pending', 'done');

  CREATE TABLE "public"."sandbox_uat_parents" (
    "id" uuid PRIMARY KEY,
    "name" text NOT NULL
  );
  INSERT INTO "public"."sandbox_uat_parents"
    ("id", "name")
  VALUES (
    '11111111-1111-4111-8111-111111111111',
    'parent-a'
  );

  CREATE TABLE "sandbox_uat"."items" (
    "id" bigserial PRIMARY KEY,
    "parent_id" uuid NOT NULL
      REFERENCES "public"."sandbox_uat_parents" ("id")
      ON DELETE CASCADE,
    "status" "sandbox_uat"."item_status" NOT NULL,
    "metadata" jsonb NOT NULL,
    "note" text
  );
`;

const insertSandboxUatItemsSql = `
  INSERT INTO "sandbox_uat"."items" (
    "parent_id",
    "status",
    "metadata",
    "note"
  )
  SELECT
    '11111111-1111-4111-8111-111111111111',
    (
      CASE WHEN g % 2 = 0
        THEN 'pending'
        ELSE 'done'
      END
    )::"sandbox_uat"."item_status",
    jsonb_build_object('index', g),
    CASE (g % 500)
      WHEN 0 THEN NULL
      WHEN 1 THEN 'tab' || chr(9) || 'here'
      WHEN 2 THEN 'line one' || chr(10) || 'line two'
      WHEN 3 THEN 'back' || chr(92) || 'slash'
      WHEN 4 THEN '한글 데이터 ' || g
      ELSE 'row-' || g
    END
  FROM generate_series(1, ${SANDBOX_UAT_ITEM_COUNT}) AS g;
`;

const countSandboxUatItemsSql = `
  SELECT count(*)::int AS n
  FROM "sandbox_uat"."items"
`;

const sandboxUatFkJoinCountSql = `
  SELECT count(*)::int AS n
  FROM "sandbox_uat"."items" i
  JOIN "public"."sandbox_uat_parents" p
    ON p."id" = i."parent_id"
`;

const maxSandboxUatItemIdSql = `
  SELECT max("id")::bigint AS max_id
  FROM "sandbox_uat"."items"
`;

const insertSandboxUatItemSql = `
  INSERT INTO "sandbox_uat"."items" (
    "parent_id",
    "status",
    "metadata",
    "note"
  )
  VALUES (
    '11111111-1111-4111-8111-111111111111',
    'pending',
    '{}'::jsonb,
    'post-restore-insert'
  )
  RETURNING "id"
`;

const selectSandboxUatSpecialRowsSql = `
  SELECT "id"::int AS id, "note", "metadata"
  FROM "sandbox_uat"."items"
  WHERE "id" IN (500, 501, 502, 503, 504)
  ORDER BY "id"
`;

const expectedSandboxUatSpecialRows = [
  { id: 500, note: null, metadata: { index: 500 } },
  { id: 501, note: "tab\there", metadata: { index: 501 } },
  { id: 502, note: "line one\nline two", metadata: { index: 502 } },
  { id: 503, note: "back\\slash", metadata: { index: 503 } },
  { id: 504, note: "한글 데이터 504", metadata: { index: 504 } },
];

const selectSandboxUatSchemaExistsSql = `
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name = 'sandbox_uat'
`;

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("paperclip-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  it(
    "keeps the newest backup for each retained calendar month",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-retention-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const janNewest = path.join(backupDir, "paperclip-test-2026-01-28T12-00-00.sql.gz");
      const janOlder = path.join(backupDir, "paperclip-test-2026-01-10T12-00-00.sql.gz");
      const decOld = path.join(backupDir, "paperclip-test-2025-12-15T12-00-00.sql.gz");

      try {
        fs.writeFileSync(janNewest, "jan-newest");
        fs.writeFileSync(janOlder, "jan-older");
        fs.writeFileSync(decOld, "dec-old");

        fs.utimesSync(janNewest, new Date("2026-01-28T12:00:00Z"), new Date("2026-01-28T12:00:00Z"));
        fs.utimesSync(janOlder, new Date("2026-01-10T12:00:00Z"), new Date("2026-01-10T12:00:00Z"));
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
          filenamePrefix: "paperclip-test",
        });

        expect(result.prunedCount).toBe(2);
        expect(fs.existsSync(janNewest)).toBe(true);
        expect(fs.existsSync(janOlder)).toBe(false);
        expect(fs.existsSync(decOld)).toBe(false);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "dryRun=true identifies prune candidates without deleting any file",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-retention-dryrun-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const janNewest = path.join(backupDir, "paperclip-test-2026-01-28T12-00-00.sql.gz");
      const janOlder = path.join(backupDir, "paperclip-test-2026-01-10T12-00-00.sql.gz");
      const decOld = path.join(backupDir, "paperclip-test-2025-12-15T12-00-00.sql.gz");

      try {
        fs.writeFileSync(janNewest, "jan-newest");
        fs.writeFileSync(janOlder, "jan-older");
        fs.writeFileSync(decOld, "dec-old");

        fs.utimesSync(janNewest, new Date("2026-01-28T12:00:00Z"), new Date("2026-01-28T12:00:00Z"));
        fs.utimesSync(janOlder, new Date("2026-01-10T12:00:00Z"), new Date("2026-01-10T12:00:00Z"));
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
          filenamePrefix: "paperclip-test",
          dryRun: true,
        });

        expect(result.prunedCount).toBe(2);
        expect(result.prunedFiles).toEqual(expect.arrayContaining([janOlder, decOld]));
        expect(fs.existsSync(janNewest)).toBe(true);
        expect(fs.existsSync(janOlder)).toBe(true);
        expect(fs.existsSync(decOld)).toBe(true);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "backs up and restores large table payloads without materializing one giant string",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);
        await sourceSql.unsafe(`
          CREATE FUNCTION "public"."backup_test_mark_done"()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            NEW."state" := 'done';
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER "backup_test_mark_done_trigger"
          BEFORE UPDATE OF "title" ON "public"."backup_test_records"
          FOR EACH ROW
          EXECUTE FUNCTION "public"."backup_test_mark_done"();
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "javascript",
        });

        expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupFile)).toBe(true);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean } | string;
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows.map((row) => ({
          ...row,
          metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        }))).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);

        await restoreSql.unsafe(`
          UPDATE "public"."backup_test_records"
          SET "title" = 'triggered'
          WHERE "title" = 'row-0'
        `);
        const triggeredRows = await restoreSql.unsafe<{ state: string }[]>(`
          SELECT "state"::text AS "state"
          FROM "public"."backup_test_records"
          WHERE "title" = 'triggered'
        `);
        expect(triggeredRows).toEqual([{ state: "done" }]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "backs up and restores non-public database schemas and migration history",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_full_logical_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-full-logical-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS "drizzle";
          CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            "id" serial PRIMARY KEY,
            "hash" text NOT NULL,
            "created_at" bigint
          );
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('paperclip-migration-history', 1770000000000);
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          INSERT INTO "public"."backup_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "note" text NOT NULL
          );
          CREATE TABLE "public"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          INSERT INTO "public"."plugin_rows" ("note")
          VALUES ('public-collision');
          INSERT INTO "public"."audit_rows" ("secret_note")
          VALUES ('public-secret');
        `);
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_backup_scope";
          CREATE TYPE "plugin_backup_scope"."plugin_status" AS ENUM ('ready', 'done');
          CREATE TABLE "plugin_backup_scope"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."backup_parent_records"("id") ON DELETE CASCADE,
            "status" "plugin_backup_scope"."plugin_status" NOT NULL,
            "note" text NOT NULL
          );
          CREATE TABLE "plugin_backup_scope"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          CREATE UNIQUE INDEX "plugin_rows_note_uq" ON "plugin_backup_scope"."plugin_rows" ("note");
          INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'ready', 'first');
          INSERT INTO "plugin_backup_scope"."audit_rows" ("secret_note")
          VALUES ('plugin-secret');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-full-logical-test",
          backupEngine: "javascript",
          excludeTables: ["plugin_rows"],
          nullifyColumns: {
            audit_rows: ["secret_note"],
          },
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const migrationRows = await restoreSql.unsafe<{ hash: string }[]>(`
          SELECT "hash"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "hash" = 'paperclip-migration-history'
        `);
        expect(migrationRows).toEqual([{ hash: "paperclip-migration-history" }]);

        const pluginRows = await restoreSql.unsafe<{ note: string; status: string; parent_name: string }[]>(`
          SELECT r."note", r."status"::text AS "status", p."name" AS "parent_name"
          FROM "plugin_backup_scope"."plugin_rows" r
          JOIN "public"."backup_parent_records" p ON p."id" = r."parent_id"
        `);
        expect(pluginRows).toEqual([{ note: "first", status: "ready", parent_name: "parent" }]);

        const publicCollisionRows = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."plugin_rows"
        `);
        expect(publicCollisionRows[0]?.count).toBe(0);

        const publicAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "public"."audit_rows"
        `);
        expect(publicAuditRows).toEqual([{ secret_note: null }]);

        const pluginAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "plugin_backup_scope"."audit_rows"
        `);
        expect(pluginAuditRows).toEqual([{ secret_note: "plugin-secret" }]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'done', 'first')
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "preserves composite foreign key column order without duplicate referenced columns",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_composite_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-composite-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_composite_fk";
          CREATE TABLE "plugin_composite_fk"."content_cases" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "title" text NOT NULL,
            CONSTRAINT "content_cases_company_case_unique" UNIQUE ("company_id", "id")
          );
          CREATE TABLE "plugin_composite_fk"."content_case_signals" (
            "company_id" uuid NOT NULL,
            "case_id" uuid NOT NULL,
            "signal" text NOT NULL,
            "scopes" text[] NOT NULL,
            "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
            CONSTRAINT "content_case_signals_company_case"
              FOREIGN KEY ("company_id", "case_id")
              REFERENCES "plugin_composite_fk"."content_cases" ("company_id", "id")
              ON DELETE CASCADE
          );
          INSERT INTO "plugin_composite_fk"."content_cases" ("company_id", "id", "title")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'case'
          );
          INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes", "warnings")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'signal',
            ARRAY['upstream_import:preview', 'scope with space', 'quoted "scope"', 'NULL', 'null'],
            jsonb_build_array('json warning', jsonb_build_object('code', 'quoted "value"'))
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-composite-fk-test",
          backupEngine: "javascript",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{
          signal: string;
          title: string;
          scopes: string[];
          warnings: Array<string | { code: string }>;
        }[]>(`
          SELECT s."signal", c."title", s."scopes", s."warnings"
          FROM "plugin_composite_fk"."content_case_signals" s
          JOIN "plugin_composite_fk"."content_cases" c
            ON c."company_id" = s."company_id"
           AND c."id" = s."case_id"
        `);
        expect(rows).toEqual([
          {
            signal: "signal",
            title: "case",
            scopes: ["upstream_import:preview", "scope with space", 'quoted "scope"', "NULL", "null"],
            warnings: ["json warning", { code: 'quoted "value"' }],
          },
        ]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes")
            VALUES (
              '11111111-1111-4111-8111-111111111111',
              '33333333-3333-4333-8333-333333333333',
              'orphan',
              ARRAY[]::text[]
            )
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores fallback COPY data when child tables are dumped before parent tables",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_copy_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-copy-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."zzz_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          CREATE TABLE "public"."aaa_child_records" (
            "id" uuid PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."zzz_parent_records"("id") ON DELETE CASCADE,
            "note" text NOT NULL
          );
          INSERT INTO "public"."zzz_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
          INSERT INTO "public"."aaa_child_records" ("id", "parent_id", "note")
          VALUES (
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            'child emitted before parent'
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-fk-test",
          backupEngine: "auto",
        });

        const backupSql = gunzipSync(await fs.promises.readFile(result.backupFile)).toString("utf8");
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeGreaterThan(-1);
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeLessThan(
          backupSql.indexOf("-- Data for: public.zzz_parent_records"),
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{ note: string; name: string }[]>(`
          SELECT child."note", parent."name"
          FROM "public"."aaa_child_records" child
          JOIN "public"."zzz_parent_records" parent ON parent."id" = child."parent_id"
        `);
        expect(rows).toEqual([{ note: "child emitted before parent", name: "parent" }]);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "round-trips NULL, tab, newline, backslash, and Korean UTF-8 values through COPY",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_copy_special_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-copy-special-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(createSpecialValuesSql);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-special-test",
          backupEngine: "auto",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{ id: string; note: string | null }[]>(
          selectSpecialValuesSql,
        );
        expect(rows).toEqual(expectedSpecialValueRows);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "executes a plain SQL statement (sequence setval) right after a COPY block",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_copy_then_sql_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-copy-then-sql-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(createCopyThenSqlSql);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-then-sql-test",
          backupEngine: "auto",
        });

        const backupSql = gunzipSync(
          await fs.promises.readFile(result.backupFile),
        ).toString("utf8");
        const copyIdx = backupSql.indexOf(copyThenSqlCopyHeaderMarker);
        const setvalIdx = backupSql.indexOf("SELECT setval(");
        expect(copyIdx).toBeGreaterThan(-1);
        expect(setvalIdx).toBeGreaterThan(copyIdx);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{ note: string }[]>(
          selectCopyThenSqlSql,
        );
        expect(rows).toEqual(expectedCopyThenSqlRows);

        const insertedRow = await restoreSql.unsafe<
          { id: string; note: string }[]
        >(insertCopyThenSqlSql);
        expect(insertedRow[0]?.note).toBe("fourth");
        expect(Number(insertedRow[0]?.id)).toBeGreaterThan(3);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "rejects a malformed COPY header fail-closed instead of misexecuting it",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, {
        max: 1,
        onnotice: () => {},
      });
      const backupDir = createTempDir("paperclip-db-restore-malformed-copy-");
      const backupFile = path.join(backupDir, "malformed-copy.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          malformedCopyHeaderBackupText,
          "utf8",
        );

        await expect(
          runDatabaseRestore({
            connectionString: restoreConnectionString,
            backupFile,
          }),
        ).rejects.toThrow("Malformed backup: invalid COPY FROM stdin header");

        const tables = await restoreSql.unsafe<{ table_name: string }[]>(
          selectMalformedCopyTestTableSql,
        );
        expect(tables).toEqual([]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );

  it(
    "F03 sandbox UAT: backs up and restores a realistic dataset in full isolation",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_sandbox_uat_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-sandbox-uat-backup-");
      const sourceSql = postgres(sourceConnectionString, {
        max: 1,
        onnotice: () => {},
      });
      const restoreSql = postgres(restoreConnectionString, {
        max: 1,
        onnotice: () => {},
      });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";

      try {
        const sourcePort = new URL(sourceConnectionString).port;
        const restorePort = new URL(restoreConnectionString).port;
        expect(sourcePort).not.toBe("54329");
        expect(restorePort).not.toBe("54329");

        const sourceDbName = new URL(sourceConnectionString).pathname;
        const restoreDbName = new URL(restoreConnectionString).pathname;
        expect(sourceDbName).not.toBe(restoreDbName);

        await sourceSql.unsafe(createSandboxUatSchemaSql);
        await sourceSql.unsafe(insertSandboxUatItemsSql);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-sandbox-uat-test",
          backupEngine: "auto",
        });

        const backupBytes = await fs.promises.readFile(result.backupFile);
        const backupSizeBytes = backupBytes.length;
        const backupSha256 = createHash("sha256")
          .update(backupBytes)
          .digest("hex");
        expect(backupSizeBytes).toBeGreaterThan(0);
        expect(backupSha256).toMatch(/^[0-9a-f]{64}$/);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const [itemCountRow] = await restoreSql.unsafe<{ n: number }[]>(
          countSandboxUatItemsSql,
        );
        expect(itemCountRow?.n).toBe(SANDBOX_UAT_ITEM_COUNT);

        const [fkJoinRow] = await restoreSql.unsafe<{ n: number }[]>(
          sandboxUatFkJoinCountSql,
        );
        expect(fkJoinRow?.n).toBe(SANDBOX_UAT_ITEM_COUNT);

        const schemaRows = await restoreSql.unsafe<{ schema_name: string }[]>(
          selectSandboxUatSchemaExistsSql,
        );
        expect(schemaRows).toHaveLength(1);

        const [maxIdRow] = await restoreSql.unsafe<{ max_id: string }[]>(
          maxSandboxUatItemIdSql,
        );
        expect(Number(maxIdRow?.max_id)).toBe(SANDBOX_UAT_ITEM_COUNT);

        const specialRows = await restoreSql.unsafe<
          { id: number; note: string | null; metadata: { index: number } }[]
        >(selectSandboxUatSpecialRowsSql);
        expect(specialRows).toEqual(expectedSandboxUatSpecialRows);

        const [insertedRow] = await restoreSql.unsafe<{ id: string }[]>(
          insertSandboxUatItemSql,
        );
        const newId = Number(insertedRow?.id);
        expect(newId).toBeGreaterThan(SANDBOX_UAT_ITEM_COUNT);

        const [duplicateIdCheck] = await restoreSql.unsafe<{ n: number }[]>(`
          SELECT count(*)::int AS n
          FROM "sandbox_uat"."items"
          WHERE "id" = ${newId}
        `);
        expect(duplicateIdCheck?.n).toBe(1);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "writes a SHA-256 manifest alongside a new backup",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-manifest-");

      const result = await runDatabaseBackup({
        connectionString: sourceConnectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        filenamePrefix: "paperclip-manifest-test",
      });

      const manifestPath = `${result.backupFile}.manifest.json`;
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest.version).toBe(1);
      expect(manifest.backupFile).toBe(path.basename(result.backupFile));
      expect(manifest.sizeBytes).toBe(result.sizeBytes);
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(new Date(manifest.createdAt).toISOString()).toBe(manifest.createdAt);

      const actualBytes = fs.readFileSync(result.backupFile);
      const actualSha256 = createHash("sha256").update(actualBytes).digest("hex");
      expect(manifest.sha256).toBe(actualSha256);
    },
    30_000,
  );

  it(
    "restores successfully when verifyManifestBeforeRestore is true and the manifest is valid",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_manifest_verified_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-manifest-verified-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."manifest_verified_rows" ("id" serial PRIMARY KEY, "note" text NOT NULL);
          INSERT INTO "public"."manifest_verified_rows" ("note") VALUES ('verified');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-manifest-verified-test",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
          verifyManifestBeforeRestore: true,
        });

        const rows = await restoreSql.unsafe<{ note: string }[]>(`
          SELECT "note" FROM "public"."manifest_verified_rows"
        `);
        expect(rows).toEqual([{ note: "verified" }]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    30_000,
  );

  it(
    "never spawns psql when forceJavaScriptEngine is set",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_force_js_no_psql_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-force-js-no-psql-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      const markerPath = path.join(backupDir, "psql-was-invoked.marker");
      const requireScript = path.join(backupDir, "mark-psql-invocation.cjs");
      fs.writeFileSync(
        requireScript,
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "invoked"); process.exit(0);`,
        "utf8",
      );
      const originalPsqlPath = process.env.PAPERCLIP_PSQL_PATH;
      const originalNodeOptions = process.env.NODE_OPTIONS;

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."force_js_no_psql_rows" ("id" serial PRIMARY KEY);
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-force-js-no-psql-test",
        });

        process.env.PAPERCLIP_PSQL_PATH = process.execPath;
        process.env.NODE_OPTIONS = `--require ${requireScript}`;

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
          forceJavaScriptEngine: true,
        });

        expect(fs.existsSync(markerPath)).toBe(false);

        const tables = await restoreSql.unsafe<{ table_name: string }[]>(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'force_js_no_psql_rows'
        `);
        expect(tables).toHaveLength(1);
      } finally {
        if (originalPsqlPath === undefined) {
          delete process.env.PAPERCLIP_PSQL_PATH;
        } else {
          process.env.PAPERCLIP_PSQL_PATH = originalPsqlPath;
        }
        if (originalNodeOptions === undefined) {
          delete process.env.NODE_OPTIONS;
        } else {
          process.env.NODE_OPTIONS = originalNodeOptions;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    30_000,
  );

  it(
    "never spawns psql when a sentinel is provided, even without forceJavaScriptEngine",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_sentinel_no_psql_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-sentinel-no-psql-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      const markerPath = path.join(backupDir, "psql-was-invoked.marker");
      const requireScript = path.join(backupDir, "mark-psql-invocation.cjs");
      fs.writeFileSync(
        requireScript,
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "invoked"); process.exit(0);`,
        "utf8",
      );
      const originalPsqlPath = process.env.PAPERCLIP_PSQL_PATH;
      const originalNodeOptions = process.env.NODE_OPTIONS;

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."sentinel_no_psql_rows" ("id" serial PRIMARY KEY);
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-sentinel-no-psql-test",
        });

        process.env.PAPERCLIP_PSQL_PATH = process.execPath;
        process.env.NODE_OPTIONS = `--require ${requireScript}`;

        const backupBytes = fs.readFileSync(result.backupFile);
        const backupSha256 = createHash("sha256").update(backupBytes).digest("hex");

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
          sentinel: {
            jobId: "22222222-2222-4222-8222-222222222222",
            backupId: path.basename(result.backupFile),
            manifestSha256: backupSha256,
          },
        });

        expect(fs.existsSync(markerPath)).toBe(false);

        const tables = await restoreSql.unsafe<{ table_name: string }[]>(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'sentinel_no_psql_rows'
        `);
        expect(tables).toHaveLength(1);
      } finally {
        if (originalPsqlPath === undefined) {
          delete process.env.PAPERCLIP_PSQL_PATH;
        } else {
          process.env.PAPERCLIP_PSQL_PATH = originalPsqlPath;
        }
        if (originalNodeOptions === undefined) {
          delete process.env.NODE_OPTIONS;
        } else {
          process.env.NODE_OPTIONS = originalNodeOptions;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    30_000,
  );

  it(
    "rejects an invalid sentinel jobId before any DB connection is attempted",
    async () => {
      await expect(
        runDatabaseRestore({
          connectionString: "postgres://unreachable:unreachable@127.0.0.1:1/nonexistent",
          backupFile: "unused.sql.gz",
          sentinel: {
            jobId: "not-a-uuid",
            backupId: "paperclip-test.sql.gz",
            manifestSha256: "a".repeat(64),
          },
        }),
      ).rejects.toThrow(/jobId/);
    },
    2_000,
  );

  it(
    "rejects an invalid sentinel backupId before any DB connection is attempted",
    async () => {
      await expect(
        runDatabaseRestore({
          connectionString: "postgres://unreachable:unreachable@127.0.0.1:1/nonexistent",
          backupFile: "unused.sql.gz",
          sentinel: {
            jobId: "11111111-1111-4111-8111-111111111111",
            backupId: "../escape.sql.gz",
            manifestSha256: "a".repeat(64),
          },
        }),
      ).rejects.toThrow(/backupId/);
    },
    2_000,
  );

  it(
    "rejects an invalid sentinel manifestSha256 before any DB connection is attempted",
    async () => {
      await expect(
        runDatabaseRestore({
          connectionString: "postgres://unreachable:unreachable@127.0.0.1:1/nonexistent",
          backupFile: "unused.sql.gz",
          sentinel: {
            jobId: "11111111-1111-4111-8111-111111111111",
            backupId: "paperclip-test.sql.gz",
            manifestSha256: "NOT-HEX-OR-WRONG-LENGTH",
          },
        }),
      ).rejects.toThrow(/manifestSha256/);
    },
    2_000,
  );

  it(
    "rejects a backup with zero top-level BEGIN statements before any DB connection",
    async () => {
      const fixtureDir = createTempDir("paperclip-db-structure-begin0-");
      const backupFile = path.join(fixtureDir, "begin0.sql");
      fs.writeFileSync(
        backupFile,
        [
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "CREATE TABLE public.structure_test_begin0 (id integer primary key);",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "COMMIT;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
        ].join("\n"),
        "utf8",
      );

      await expect(
        runDatabaseRestore({
          connectionString: "postgres://unreachable:unreachable@127.0.0.1:1/nonexistent",
          backupFile,
          forceJavaScriptEngine: true,
        }),
      ).rejects.toThrow(/exactly one BEGIN/);
    },
    2_000,
  );

  it(
    "rejects a backup with two top-level BEGIN statements before any DB connection",
    async () => {
      const fixtureDir = createTempDir("paperclip-db-structure-begin2-");
      const backupFile = path.join(fixtureDir, "begin2.sql");
      fs.writeFileSync(
        backupFile,
        [
          "BEGIN;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "BEGIN;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "CREATE TABLE public.structure_test_begin2 (id integer primary key);",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "COMMIT;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
        ].join("\n"),
        "utf8",
      );

      await expect(
        runDatabaseRestore({
          connectionString: "postgres://unreachable:unreachable@127.0.0.1:1/nonexistent",
          backupFile,
          forceJavaScriptEngine: true,
        }),
      ).rejects.toThrow(/exactly one BEGIN/);
    },
    2_000,
  );

  it(
    "rejects a backup whose BEGIN is not the first statement before any DB connection",
    async () => {
      const fixtureDir = createTempDir("paperclip-db-structure-begin-not-first-");
      const backupFile = path.join(fixtureDir, "begin-not-first.sql");
      fs.writeFileSync(
        backupFile,
        [
          "SELECT 1;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "BEGIN;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "CREATE TABLE public.structure_test_begin_not_first (id integer primary key);",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "COMMIT;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
        ].join("\n"),
        "utf8",
      );

      await expect(
        runDatabaseRestore({
          connectionString: "postgres://unreachable:unreachable@127.0.0.1:1/nonexistent",
          backupFile,
          forceJavaScriptEngine: true,
        }),
      ).rejects.toThrow(/exactly one BEGIN/);
    },
    2_000,
  );

  it(
    "rejects a backup with zero top-level COMMIT statements before any DB connection",
    async () => {
      const fixtureDir = createTempDir("paperclip-db-structure-commit0-");
      const backupFile = path.join(fixtureDir, "commit0.sql");
      fs.writeFileSync(
        backupFile,
        [
          "BEGIN;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "CREATE TABLE public.structure_test_commit0 (id integer primary key);",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
        ].join("\n"),
        "utf8",
      );

      await expect(
        runDatabaseRestore({
          connectionString: "postgres://unreachable:unreachable@127.0.0.1:1/nonexistent",
          backupFile,
          forceJavaScriptEngine: true,
        }),
      ).rejects.toThrow(/exactly one COMMIT/);
    },
    2_000,
  );

  it(
    "rejects a backup with two top-level COMMIT statements before any DB connection",
    async () => {
      const fixtureDir = createTempDir("paperclip-db-structure-commit2-");
      const backupFile = path.join(fixtureDir, "commit2.sql");
      fs.writeFileSync(
        backupFile,
        [
          "BEGIN;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "CREATE TABLE public.structure_test_commit2 (id integer primary key);",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "COMMIT;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "COMMIT;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
        ].join("\n"),
        "utf8",
      );

      await expect(
        runDatabaseRestore({
          connectionString: "postgres://unreachable:unreachable@127.0.0.1:1/nonexistent",
          backupFile,
          forceJavaScriptEngine: true,
        }),
      ).rejects.toThrow(/exactly one COMMIT/);
    },
    2_000,
  );

  it(
    "rejects a backup whose COMMIT is not the last statement before any DB connection",
    async () => {
      const fixtureDir = createTempDir("paperclip-db-structure-commit-not-last-");
      const backupFile = path.join(fixtureDir, "commit-not-last.sql");
      fs.writeFileSync(
        backupFile,
        [
          "BEGIN;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "CREATE TABLE public.structure_test_commit_not_last (id integer primary key);",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "COMMIT;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          "SELECT 1;",
          "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
        ].join("\n"),
        "utf8",
      );

      await expect(
        runDatabaseRestore({
          connectionString: "postgres://unreachable:unreachable@127.0.0.1:1/nonexistent",
          backupFile,
          forceJavaScriptEngine: true,
        }),
      ).rejects.toThrow(/exactly one COMMIT/);
    },
    2_000,
  );

  it(
    "ignores BEGIN;/COMMIT; strings that appear inside COPY data when validating transaction structure",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_copy_data_begin_commit_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-copy-data-begin-commit-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."copy_data_begin_commit_rows" ("id" serial PRIMARY KEY, "note" text NOT NULL);
          INSERT INTO "public"."copy_data_begin_commit_rows" ("note") VALUES ('BEGIN;'), ('COMMIT;');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-data-begin-commit-test",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
          forceJavaScriptEngine: true,
        });

        const rows = await restoreSql.unsafe<{ note: string }[]>(`
          SELECT "note" FROM "public"."copy_data_begin_commit_rows" ORDER BY "id"
        `);
        expect(rows).toEqual([{ note: "BEGIN;" }, { note: "COMMIT;" }]);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    30_000,
  );

  it(
    "commits the sentinel journal row together with the restored data",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_sentinel_commit_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-sentinel-commit-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."sentinel_commit_rows" ("id" serial PRIMARY KEY, "note" text NOT NULL);
          INSERT INTO "public"."sentinel_commit_rows" ("note") VALUES ('committed-together');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-sentinel-commit-test",
        });

        const backupBytes = fs.readFileSync(result.backupFile);
        const backupSha256 = createHash("sha256").update(backupBytes).digest("hex");
        const jobId = "33333333-3333-4333-8333-333333333333";

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
          sentinel: {
            jobId,
            backupId: path.basename(result.backupFile),
            manifestSha256: backupSha256,
          },
        });

        const rows = await restoreSql.unsafe<{ note: string }[]>(`
          SELECT "note" FROM "public"."sentinel_commit_rows"
        `);
        expect(rows).toEqual([{ note: "committed-together" }]);

        const journalRows = await restoreSql.unsafe<{ job_id: string; backup_id: string }[]>(`
          SELECT "job_id"::text, "backup_id" FROM "_paperclip_restore_control"."journal" WHERE "job_id" = '${jobId}'
        `);
        expect(journalRows).toHaveLength(1);
        expect(journalRows[0]?.backup_id).toBe(path.basename(result.backupFile));

        const entry = await queryRestoreJournalEntry(restoreConnectionString, jobId);
        expect(entry).not.toBeNull();
        expect(entry?.jobId).toBe(jobId);
        expect(entry?.backupId).toBe(path.basename(result.backupFile));
        expect(entry?.manifestSha256).toBe(backupSha256);
        expect(typeof entry?.completedAt).toBe("string");
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    30_000,
  );

  it(
    "queryRestoreJournalEntry returns null when the journal table does not exist yet (fresh database, no restore ever committed)",
    async () => {
      const connectionString = await createTempDatabase();
      const entry = await queryRestoreJournalEntry(connectionString, "11111111-1111-4111-8111-111111111111");
      expect(entry).toBeNull();
    },
    30_000,
  );

  it(
    "queryRestoreJournalEntry returns null for a job id not present in an existing journal table",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_sentinel_journal_lookup_miss_target",
      );
      const backupDir = createTempDir("paperclip-db-sentinel-journal-lookup-miss-");
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";

      try {
        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-sentinel-journal-lookup-miss-test",
        });

        const backupBytes = fs.readFileSync(result.backupFile);
        const backupSha256 = createHash("sha256").update(backupBytes).digest("hex");
        const committedJobId = "22222222-2222-4222-8222-222222222222";

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
          sentinel: {
            jobId: committedJobId,
            backupId: path.basename(result.backupFile),
            manifestSha256: backupSha256,
          },
        });

        // The journal table now exists (a different job committed it), but
        // this specific job id was never recorded -- still null, not an error.
        const entry = await queryRestoreJournalEntry(
          restoreConnectionString,
          "33333333-3333-4333-8333-333333333334",
        );
        expect(entry).toBeNull();
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
      }
    },
    30_000,
  );

  it(
    "rolls back all restored data when the sentinel insert hits a PK conflict, leaving the pre-existing journal row untouched",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_sentinel_pk_conflict_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-sentinel-pk-conflict-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";
      const jobId = "44444444-4444-4444-8444-444444444444";

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."sentinel_pk_conflict_rows" ("id" serial PRIMARY KEY);
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-sentinel-pk-conflict-test",
        });

        const backupBytes = fs.readFileSync(result.backupFile);
        const backupSha256 = createHash("sha256").update(backupBytes).digest("hex");

        await restoreSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS "_paperclip_restore_control";
          CREATE TABLE IF NOT EXISTS "_paperclip_restore_control"."journal" (
            "job_id" uuid PRIMARY KEY,
            "backup_id" text NOT NULL,
            "manifest_sha256" text NOT NULL,
            "completed_at" timestamptz NOT NULL
          );
          INSERT INTO "_paperclip_restore_control"."journal" ("job_id", "backup_id", "manifest_sha256", "completed_at")
          VALUES ('${jobId}', 'pre-existing-backup-id.sql.gz', '${"a".repeat(64)}', '2020-01-01T00:00:00Z');
        `);

        await expect(
          runDatabaseRestore({
            connectionString: restoreConnectionString,
            backupFile: result.backupFile,
            sentinel: {
              jobId,
              backupId: path.basename(result.backupFile),
              manifestSha256: backupSha256,
            },
          }),
        ).rejects.toThrow();

        const tables = await restoreSql.unsafe<{ table_name: string }[]>(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'sentinel_pk_conflict_rows'
        `);
        expect(tables).toEqual([]);

        const journalRows = await restoreSql.unsafe<{ backup_id: string }[]>(`
          SELECT "backup_id" FROM "_paperclip_restore_control"."journal" WHERE "job_id" = '${jobId}'
        `);
        expect(journalRows).toHaveLength(1);
        expect(journalRows[0]?.backup_id).toBe("pre-existing-backup-id.sql.gz");
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    30_000,
  );

  it(
    "rejects restore when the manifest is missing, without touching the target database",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_manifest_missing_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-manifest-missing-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."manifest_missing_rows" ("id" serial PRIMARY KEY);
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-manifest-missing-test",
        });

        fs.unlinkSync(`${result.backupFile}.manifest.json`);

        await expect(
          runDatabaseRestore({
            connectionString: restoreConnectionString,
            backupFile: result.backupFile,
            verifyManifestBeforeRestore: true,
          }),
        ).rejects.toThrow("manifest missing");

        const tables = await restoreSql.unsafe<{ table_name: string }[]>(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'manifest_missing_rows'
        `);
        expect(tables).toEqual([]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    30_000,
  );

  it(
    "rejects restore when the manifest is corrupted, without touching the target database",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_manifest_corrupted_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-manifest-corrupted-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."manifest_corrupted_rows" ("id" serial PRIMARY KEY);
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-manifest-corrupted-test",
        });

        fs.writeFileSync(`${result.backupFile}.manifest.json`, "{not valid json", "utf8");

        await expect(
          runDatabaseRestore({
            connectionString: restoreConnectionString,
            backupFile: result.backupFile,
            verifyManifestBeforeRestore: true,
          }),
        ).rejects.toThrow("manifest corrupted");

        const tables = await restoreSql.unsafe<{ table_name: string }[]>(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'manifest_corrupted_rows'
        `);
        expect(tables).toEqual([]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    30_000,
  );

  it(
    "rejects restore when the manifest sha256 does not match the backup file, without touching the target database",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_manifest_hash_mismatch_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-manifest-hash-mismatch-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."manifest_hash_mismatch_rows" ("id" serial PRIMARY KEY);
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-manifest-hash-mismatch-test",
        });

        const manifestPath = `${result.backupFile}.manifest.json`;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.sha256 = "0".repeat(64);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

        await expect(
          runDatabaseRestore({
            connectionString: restoreConnectionString,
            backupFile: result.backupFile,
            verifyManifestBeforeRestore: true,
          }),
        ).rejects.toThrow("sha256 mismatch");

        const tables = await restoreSql.unsafe<{ table_name: string }[]>(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'manifest_hash_mismatch_rows'
        `);
        expect(tables).toEqual([]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    30_000,
  );

  it(
    "rejects restore when the manifest sizeBytes does not match the backup file, without touching the target database",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_manifest_size_mismatch_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-manifest-size-mismatch-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."manifest_size_mismatch_rows" ("id" serial PRIMARY KEY);
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-manifest-size-mismatch-test",
        });

        const manifestPath = `${result.backupFile}.manifest.json`;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.sizeBytes = manifest.sizeBytes + 1;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

        await expect(
          runDatabaseRestore({
            connectionString: restoreConnectionString,
            backupFile: result.backupFile,
            verifyManifestBeforeRestore: true,
          }),
        ).rejects.toThrow("sizeBytes mismatch");

        const tables = await restoreSql.unsafe<{ table_name: string }[]>(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'manifest_size_mismatch_rows'
        `);
        expect(tables).toEqual([]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    30_000,
  );

  it(
    "retention pruning deletes a pruned backup's manifest alongside the backup file",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-manifest-retention-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const decOld = path.join(
        backupDir,
        "paperclip-manifest-retention-test-2025-12-15T12-00-00.sql.gz",
      );
      const decOldManifest = `${decOld}.manifest.json`;

      try {
        fs.writeFileSync(decOld, "dec-old");
        fs.writeFileSync(decOldManifest, JSON.stringify({ version: 1 }));
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-manifest-retention-test",
        });

        expect(result.prunedFiles).toContain(decOld);
        expect(fs.existsSync(decOld)).toBe(false);
        expect(fs.existsSync(decOldManifest)).toBe(false);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "dryRun retention leaves a prune candidate's backup and manifest both untouched",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-manifest-retention-dryrun-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const decOld = path.join(
        backupDir,
        "paperclip-manifest-retention-dryrun-test-2025-12-15T12-00-00.sql.gz",
      );
      const decOldManifest = `${decOld}.manifest.json`;

      try {
        fs.writeFileSync(decOld, "dec-old");
        fs.writeFileSync(decOldManifest, JSON.stringify({ version: 1 }));
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-manifest-retention-dryrun-test",
          dryRun: true,
        });

        expect(result.prunedFiles).toContain(decOld);
        expect(fs.existsSync(decOld)).toBe(true);
        expect(fs.existsSync(decOldManifest)).toBe(true);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "excludes a pinned backup from retention deletion",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-pin-retention-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const decOld = path.join(
        backupDir,
        "paperclip-pin-retention-test-2025-12-15T12-00-00.sql.gz",
      );
      const pinPath = `${decOld}.pinned`;

      try {
        fs.writeFileSync(decOld, "dec-old");
        fs.writeFileSync(pinPath, "");
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-pin-retention-test",
        });

        expect(result.prunedFiles).not.toContain(decOld);
        expect(fs.existsSync(decOld)).toBe(true);
        expect(fs.existsSync(pinPath)).toBe(true);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "dryRun also excludes a pinned backup from the reported prune candidates",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-pin-retention-dryrun-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const decOld = path.join(
        backupDir,
        "paperclip-pin-retention-dryrun-test-2025-12-15T12-00-00.sql.gz",
      );
      const pinPath = `${decOld}.pinned`;

      try {
        fs.writeFileSync(decOld, "dec-old");
        fs.writeFileSync(pinPath, "");
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-pin-retention-dryrun-test",
          dryRun: true,
        });

        expect(result.prunedFiles).not.toContain(decOld);
        expect(fs.existsSync(decOld)).toBe(true);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "prunes a non-pinned old backup exactly as before when no pin exists",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-no-pin-retention-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const decOld = path.join(
        backupDir,
        "paperclip-no-pin-retention-test-2025-12-15T12-00-00.sql.gz",
      );

      try {
        fs.writeFileSync(decOld, "dec-old");
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-no-pin-retention-test",
        });

        expect(result.prunedFiles).toContain(decOld);
        expect(fs.existsSync(decOld)).toBe(false);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "retention manifest deletion failure is not reported as success",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-manifest-delete-failure-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const decOld = path.join(
        backupDir,
        "paperclip-manifest-delete-failure-test-2025-12-15T12-00-00.sql.gz",
      );
      const decOldManifestDir = `${decOld}.manifest.json`;

      try {
        fs.writeFileSync(decOld, "dec-old");
        // A directory at the manifest path (instead of a regular file) makes
        // unlinkSync fail deterministically with EPERM on this platform --
        // confirmed by direct probe, so no readonly-attribute/chmod trickery
        // (unreliable on Windows) is needed here.
        fs.mkdirSync(decOldManifestDir);
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        await expect(
          runDatabaseBackup({
            connectionString: sourceConnectionString,
            backupDir,
            retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
            filenamePrefix: "paperclip-manifest-delete-failure-test",
          }),
        ).rejects.toMatchObject({ code: "EPERM" });

        expect(fs.existsSync(decOldManifestDir)).toBe(true);
      } finally {
        Date.now = realDateNow;
        fs.rmSync(decOldManifestDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "restores legacy public-only backups without migration history",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-restore-manual-");
      const backupFile = path.join(backupDir, "manual.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "-- Paperclip database backup",
            "-- Created: 2026-04-06T00:00:00.000Z",
            "",
            "BEGIN;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "CREATE TABLE public.restore_stream_test (id integer primary key, payload text not null);",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "INSERT INTO public.restore_stream_test (id, payload)",
            "VALUES (1, 'hello');",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "COMMIT;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          ].join("\n"),
          "utf8",
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile,
        });

        const rows = await restoreSql.unsafe<{ payload: string }[]>(`
          SELECT payload
          FROM public.restore_stream_test
        `);
        expect(rows).toEqual([{ payload: "hello" }]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );
});

describeEmbeddedPostgres("runDatabaseBackup gzip-finalize failure handling", () => {
  async function seedOneRow(connectionString: string) {
    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`
        CREATE TABLE "public"."gzip_finalize_test" ("id" serial PRIMARY KEY, "payload" text NOT NULL);
      `);
      await sql`INSERT INTO "public"."gzip_finalize_test" ("payload") VALUES (${"x".repeat(4096)})`;
    } finally {
      await sql.end();
    }
  }

  it(
    "[B] a gzip timeout rejects with phase=gzip_finalize, preserves the raw .sql, removes the partial .gz, and releases the in-flight guard for the next attempt",
    async () => {
      const connectionString = await createTempDatabase();
      await seedOneRow(connectionString);
      const backupDir = createTempDir("paperclip-db-backup-gzip-timeout-");
      const events: BackupLifecycleEvent[] = [];

      // Simulates the exact try/finally shape server/src/index.ts wraps every
      // scheduled backup in: a hang here would previously leave `inFlight`
      // stuck true forever. A rejection (timeout or otherwise) always runs
      // the finally, regardless of what the backup itself did.
      let inFlight = false;
      const attempt = () => {
        if (inFlight) throw new Error("a previous backup is still running");
        inFlight = true;
        return runDatabaseBackup({
          connectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "javascript",
          gzipTimeoutMs: 1,
          onEvent: (event) => events.push(event),
        }).finally(() => {
          inFlight = false;
        });
      };

      await expect(attempt()).rejects.toMatchObject({ phase: "gzip_finalize" });
      expect(inFlight).toBe(false);

      const sqlFiles = fs.readdirSync(backupDir).filter((name) => name.endsWith(".sql"));
      const gzFiles = fs.readdirSync(backupDir).filter((name) => name.endsWith(".sql.gz"));
      expect(sqlFiles).toHaveLength(1);
      expect(gzFiles).toHaveLength(0);

      expect(events.map((e) => e.type)).toEqual([
        "engine_selected",
        "gzip_started",
        "gzip_timeout",
        "partial_gzip_removed",
        "raw_sql_preserved",
      ]);

      // The guard was released, so a second attempt is not skipped as
      // "already running" — it genuinely runs again (and, with the same
      // 1ms budget, also times out, but that is a different, honest
      // failure — not a silent skip).
      await expect(attempt()).rejects.toMatchObject({ phase: "gzip_finalize" });
      expect(inFlight).toBe(false);
    },
    30_000,
  );

  it(
    "[C] a non-timeout gzip failure also preserves the raw .sql and reports gzip_failed (not gzip_timeout)",
    async () => {
      const connectionString = await createTempDatabase();
      await seedOneRow(connectionString);
      const backupDir = createTempDir("paperclip-db-backup-gzip-failure-");
      const events: BackupLifecycleEvent[] = [];

      // Force the compression write step itself to fail (not merely run
      // slowly): pre-create a directory at the exact path the backup will
      // try to open as a write stream, which fails immediately with EISDIR.
      // The clock is faked (not just Date.now, since timestamp() builds its
      // stamp from `new Date()`) so the collision path is known ahead of time.
      const filenamePrefix = "paperclip-test";
      const fixedNow = Date.UTC(2026, 5, 15, 8, 30, 0);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(fixedNow);
      const pad = (n: number) => String(n).padStart(2, "0");
      const fixedDate = new Date(fixedNow);
      const expectedStamp = `${fixedDate.getFullYear()}${pad(fixedDate.getMonth() + 1)}${pad(fixedDate.getDate())}-${pad(fixedDate.getHours())}${pad(fixedDate.getMinutes())}${pad(fixedDate.getSeconds())}`;
      const expectedGzPath = path.join(backupDir, `${filenamePrefix}-${expectedStamp}.sql.gz`);
      fs.mkdirSync(expectedGzPath, { recursive: true });

      try {
        await expect(
          runDatabaseBackup({
            connectionString,
            backupDir,
            retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
            filenamePrefix,
            backupEngine: "javascript",
            onEvent: (event) => events.push(event),
          }),
        ).rejects.toMatchObject({ phase: "gzip_finalize" });
      } finally {
        vi.useRealTimers();
      }

      const timeoutEvents = events.filter((e) => e.type === "gzip_timeout");
      const failedEvents = events.filter((e) => e.type === "gzip_failed");
      expect(timeoutEvents).toHaveLength(0);
      expect(failedEvents.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === "raw_sql_preserved")).toBe(true);

      const sqlFiles = fs.readdirSync(backupDir).filter((name) => name.endsWith(".sql"));
      expect(sqlFiles).toHaveLength(1);
    },
    30_000,
  );

  it(
    "[A] a normal gzip pipeline still succeeds and cleans up the raw .sql (regression)",
    async () => {
      const connectionString = await createTempDatabase();
      await seedOneRow(connectionString);
      const backupDir = createTempDir("paperclip-db-backup-gzip-success-");
      const events: BackupLifecycleEvent[] = [];

      const result = await runDatabaseBackup({
        connectionString,
        backupDir,
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        filenamePrefix: "paperclip-test",
        backupEngine: "javascript",
        onEvent: (event) => events.push(event),
      });

      expect(fs.existsSync(result.backupFile)).toBe(true);
      expect(result.backupFile.endsWith(".sql.gz")).toBe(true);
      const sqlFiles = fs.readdirSync(backupDir).filter((name) => name.endsWith(".sql"));
      expect(sqlFiles).toHaveLength(0);
      expect(events.map((e) => e.type)).toEqual(["engine_selected", "gzip_started"]);
      expect(events.every((e) => e.type !== "gzip_timeout" && e.type !== "gzip_failed")).toBe(true);
    },
    30_000,
  );
});
