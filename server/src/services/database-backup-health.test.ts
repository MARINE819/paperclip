import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDatabaseBackupHealth } from "./database-backup-health.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createBackupDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-backup-health-"));
  tempDirs.push(dir);
  return dir;
}

function writeGzipFile(dir: string, name: string, body: Buffer): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, body);
  return filePath;
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

describe("inspectDatabaseBackupHealth", () => {
  it("[D] a corrupted/tiny .gz is not reported as the latest successful backup", () => {
    const backupDir = createBackupDir();
    // Real backups produced by this system are multi-megabyte; a truncated
    // gzip stream from an interrupted compression step is tiny even though
    // it can still carry a technically-valid gzip header.
    writeGzipFile(backupDir, "paperclip-20260101-000000.sql.gz", Buffer.concat([GZIP_MAGIC, Buffer.from([0x00])]));

    const result = inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
    });

    expect(result.latestBackup).toBeNull();
    expect(result.warnings.some((warning) => warning.code === "database_backup_missing")).toBe(true);
  });

  it("[D] a non-gzip file named .sql.gz is not reported as the latest successful backup", () => {
    const backupDir = createBackupDir();
    writeGzipFile(backupDir, "paperclip-20260101-000000.sql.gz", Buffer.alloc(8192, "x"));

    const result = inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
    });

    expect(result.latestBackup).toBeNull();
    expect(result.warnings.some((warning) => warning.code === "database_backup_missing")).toBe(true);
  });

  it("[D] a valid, large gzip-magic backup is reported as the latest successful backup", () => {
    const backupDir = createBackupDir();
    const validBody = Buffer.concat([GZIP_MAGIC, Buffer.alloc(8192, 0)]);
    writeGzipFile(backupDir, "paperclip-20260101-000000.sql.gz", validBody);

    const result = inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
    });

    expect(result.latestBackup).not.toBeNull();
    expect(result.latestBackup?.name).toBe("paperclip-20260101-000000.sql.gz");
    expect(result.status).toBe("ok");
  });

  it(
    "[E] a same-timestamp raw .sql sibling of a corrupt newest .gz is surfaced as latestRecoveryArtifact, " +
      "not confused with a successful backup",
    () => {
      const backupDir = createBackupDir();
      // An older, genuinely valid backup exists...
      const olderValidBody = Buffer.concat([GZIP_MAGIC, Buffer.alloc(8192, 0)]);
      const olderPath = writeGzipFile(backupDir, "paperclip-20260101-000000.sql.gz", olderValidBody);
      // ...but the newest run's gzip step failed, leaving a truncated .gz
      // and the raw .sql it was compressing from (per the minimal safe fix,
      // the raw .sql is preserved rather than deleted on gzip failure).
      const brokenGz = writeGzipFile(backupDir, "paperclip-20260201-000000.sql.gz", Buffer.concat([GZIP_MAGIC]));
      const rawSqlPath = path.join(backupDir, "paperclip-20260201-000000.sql");
      writeFileSync(rawSqlPath, "-- raw dump content\n".repeat(500), "utf8");

      // Ensure the broken .gz is mtime-newest so it is the one findLatestBackup
      // inspects as the "newest candidate" that fails validation.
      const now = new Date();
      const olderTime = new Date(now.getTime() - 60 * 60 * 1000);
      utimesSync(olderPath, olderTime, olderTime);
      utimesSync(brokenGz, now, now);
      utimesSync(rawSqlPath, now, now);

      const result = inspectDatabaseBackupHealth({
        enabled: true,
        backupDir,
        maxAgeHours: 26,
      });

      expect(result.latestBackup?.name).toBe("paperclip-20260101-000000.sql.gz");
      expect(result.latestRecoveryArtifact).not.toBeNull();
      expect(result.latestRecoveryArtifact?.name).toBe("paperclip-20260201-000000.sql");
      expect(result.latestRecoveryArtifact?.reason).toContain("paperclip-20260201-000000.sql.gz");
    },
  );

  it("[E] no recovery artifact is reported when the newest .gz is itself valid", () => {
    const backupDir = createBackupDir();
    const validBody = Buffer.concat([GZIP_MAGIC, Buffer.alloc(8192, 0)]);
    writeGzipFile(backupDir, "paperclip-20260101-000000.sql.gz", validBody);

    const result = inspectDatabaseBackupHealth({
      enabled: true,
      backupDir,
      maxAgeHours: 26,
    });

    expect(result.latestRecoveryArtifact).toBeNull();
  });
});
