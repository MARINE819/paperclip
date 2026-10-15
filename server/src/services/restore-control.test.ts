import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RESTORE_ATTEMPTS,
  resumeDatabaseRestoreIfNeeded,
} from "./restore-control.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const FLAG = "PAPERCLIP_DB_RESTORE_EXECUTION_ENABLED";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  delete process.env[FLAG];
  vi.restoreAllMocks();
});

function createTempHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-restore-resume-"));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function restoreJobsDir(homeDir: string): string {
  return path.join(resolvePaperclipInstanceRoot({ homeDir }), "restore-jobs");
}

function activeJobFilePath(homeDir: string): string {
  return path.join(restoreJobsDir(homeDir), "active-job.json");
}

function archiveFilePath(homeDir: string, jobId: string): string {
  return path.join(restoreJobsDir(homeDir), "archive", jobId + ".json");
}

function lockDirPath(homeDir: string): string {
  return path.join(restoreJobsDir(homeDir), "transition.lock");
}

function writeActiveJob(homeDir: string, overrides: Record<string, unknown>): Record<string, unknown> {
  const dir = restoreJobsDir(homeDir);
  fs.mkdirSync(dir, { recursive: true });
  const job: Record<string, unknown> = {
    version: 1,
    jobId: "job-1",
    backupId: "paperclip-test.sql.gz",
    manifestSha256: "a".repeat(64),
    state: "shutting_down",
    requestedBy: "test-actor",
    requestedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    restoreAttempts: 0,
  };
  for (const key of Object.keys(overrides)) {
    job[key] = overrides[key];
  }
  fs.writeFileSync(activeJobFilePath(homeDir), JSON.stringify(job, null, 2), "utf8");
  return job;
}

function readActiveJobRaw(homeDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(activeJobFilePath(homeDir), "utf8"));
  } catch {
    return null;
  }
}

const VALID_JOURNAL_MATCH = {
  jobId: "job-1",
  backupId: "paperclip-test.sql.gz",
  manifestSha256: "a".repeat(64),
  completedAt: "2026-01-01T00:00:00.000Z",
};

describe("resumeDatabaseRestoreIfNeeded", () => {
  it("flag off: zero active-job reads, zero journal queries, zero writes, zero restore calls", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down" });
    delete process.env[FLAG];

    let readCalls = 0;
    let queryCalls = 0;
    let writeJobCalls = 0;
    let restoreCalls = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/does-not-matter",
      homeDir,
      readActiveJobFile: async (p) => {
        readCalls += 1;
        return fs.readFileSync(p, "utf8");
      },
      queryJournalEntry: async () => {
        queryCalls += 1;
        return null;
      },
      writeJobFile: async () => {
        writeJobCalls += 1;
      },
      runRestore: async () => {
        restoreCalls += 1;
      },
    });

    expect(readCalls).toBe(0);
    expect(queryCalls).toBe(0);
    expect(writeJobCalls).toBe(0);
    expect(restoreCalls).toBe(0);
    const job = readActiveJobRaw(homeDir);
    expect(job?.state).toBe("shutting_down");
  });

  it("no active job file (ENOENT): logs nothing, resolves normally", async () => {
    const homeDir = createTempHomeDir();
    process.env[FLAG] = "true";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);

    await expect(
      resumeDatabaseRestoreIfNeeded({
        connectionString: "postgres://example/db",
        backupDir: "/does-not-matter",
        homeDir,
      }),
    ).resolves.toBeUndefined();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(false);
  });

  it("active-job read fails for a reason other than ENOENT: logs the fixed code only, never the raw error", async () => {
    const homeDir = createTempHomeDir();
    process.env[FLAG] = "true";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);

    await expect(
      resumeDatabaseRestoreIfNeeded({
        connectionString: "postgres://example/db",
        backupDir: "/does-not-matter",
        homeDir,
        readActiveJobFile: async () => {
          throw Object.assign(new Error("permission denied on /super/secret/path"), { code: "EACCES" });
        },
      }),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith({ code: "active_restore_job_unreadable" });
    const loggedArgs = JSON.stringify(warnSpy.mock.calls);
    expect(loggedArgs.includes("permission denied")).toBe(false);
    expect(loggedArgs.includes("/super/secret/path")).toBe(false);
  });

  it("malformed active-job.json: logs the fixed code only", async () => {
    const homeDir = createTempHomeDir();
    const dir = restoreJobsDir(homeDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(activeJobFilePath(homeDir), "{ not valid json", "utf8");
    process.env[FLAG] = "true";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);

    await expect(
      resumeDatabaseRestoreIfNeeded({
        connectionString: "postgres://example/db",
        backupDir: "/backups",
        homeDir,
      }),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith({ code: "active_restore_job_unreadable" });
  });

  it("accepted state: no-op, left untouched", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "accepted" });
    process.env[FLAG] = "true";

    let queryCalls = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/does-not-matter",
      homeDir,
      queryJournalEntry: async () => {
        queryCalls += 1;
        return null;
      },
    });

    expect(queryCalls).toBe(0);
    const job = readActiveJobRaw(homeDir);
    expect(job?.state).toBe("accepted");
  });

  it("lock acquisition itself throws: state unchanged, resolves normally, logs fixed code only", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down" });
    process.env[FLAG] = "true";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);

    let restoreCalls = 0;
    await expect(
      resumeDatabaseRestoreIfNeeded({
        connectionString: "postgres://example/db",
        backupDir: "/does-not-matter",
        homeDir,
        acquireLock: async () => {
          throw new Error("injected: lock acquisition itself failed, connection string postgres://u:p@host/db");
        },
        runRestore: async () => {
          restoreCalls += 1;
        },
      }),
    ).resolves.toBeUndefined();

    expect(restoreCalls).toBe(0);
    const job = readActiveJobRaw(homeDir);
    expect(job?.state).toBe("shutting_down");
    expect(warnSpy).toHaveBeenCalledWith({ jobId: "job-1", code: "restore_lock_acquisition_failed" });
    const loggedArgs = JSON.stringify(warnSpy.mock.calls);
    expect(loggedArgs.includes("postgres://u:p@host/db")).toBe(false);
  });

  it("lock.ok=false: state unchanged, resolves normally, logs fixed code and safe reason only", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down" });
    process.env[FLAG] = "true";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);

    let restoreCalls = 0;
    await expect(
      resumeDatabaseRestoreIfNeeded({
        connectionString: "postgres://example/db",
        backupDir: "/does-not-matter",
        homeDir,
        acquireLock: async () => ({ ok: false, reason: "lock_held_by_live_process" }),
        runRestore: async () => {
          restoreCalls += 1;
        },
      }),
    ).resolves.toBeUndefined();

    expect(restoreCalls).toBe(0);
    const job = readActiveJobRaw(homeDir);
    expect(job?.state).toBe("shutting_down");
    expect(warnSpy).toHaveBeenCalledWith({
      jobId: "job-1",
      code: "restore_lock_unavailable",
      reason: "lock_held_by_live_process",
    });
  });

  it("journal query failure: archives as failed/journal_query_failed, releases lock, never calls restore", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    let restoreCalls = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/does-not-matter",
      homeDir,
      queryJournalEntry: async () => {
        throw new Error("injected: connection refused");
      },
      runRestore: async () => {
        restoreCalls += 1;
      },
    });

    expect(restoreCalls).toBe(0);
    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(false);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("failed");
    expect(archive.lastError).toEqual({
      code: "journal_query_failed",
      message: "Could not query the restore journal; manual review required",
    });
    expect(fs.existsSync(lockDirPath(homeDir))).toBe(false);
  });

  it("journal mismatch (pre-check): failed/journal_mismatch even with attempts remaining, never calls restore", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    let restoreCalls = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/does-not-matter",
      homeDir,
      queryJournalEntry: async () => ({
        jobId: "job-1",
        backupId: "some-other-backup.sql.gz",
        manifestSha256: "b".repeat(64),
        completedAt: new Date().toISOString(),
      }),
      runRestore: async () => {
        restoreCalls += 1;
      },
    });

    expect(restoreCalls).toBe(0);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("failed");
    expect(archive.lastError.code).toBe("journal_mismatch");
  });

  it("journal mismatch (pre-check): same backupId/manifestSha256 but a different jobId is still journal_mismatch, never calls restore", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    let restoreCalls = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/does-not-matter",
      homeDir,
      queryJournalEntry: async () => ({
        jobId: "some-other-job-id",
        backupId: "paperclip-test.sql.gz",
        manifestSha256: "a".repeat(64),
        completedAt: new Date().toISOString(),
      }),
      runRestore: async () => {
        restoreCalls += 1;
      },
    });

    expect(restoreCalls).toBe(0);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("failed");
    expect(archive.lastError.code).toBe("journal_mismatch");
  });

  it("journal absent, attempts remaining: persists incremented attempts before calling restore, then succeeded", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    let callCount = 0;
    let journalCallCount = 0;
    let attemptsAtRestoreCallTime: number | null = null;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => {
        journalCallCount += 1;
        if (journalCallCount === 1) return null;
        return VALID_JOURNAL_MATCH;
      },
      runRestore: async () => {
        callCount += 1;
        const job = readActiveJobRaw(homeDir);
        attemptsAtRestoreCallTime = job?.restoreAttempts as number;
      },
    });

    expect(callCount).toBe(1);
    expect(attemptsAtRestoreCallTime).toBe(1);
    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(false);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("succeeded");
    expect(archive.restoreAttempts).toBe(1);
  });

  it("attempts already exhausted: failed/retry_limit_exceeded, never calls restore", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "restoring", restoreAttempts: MAX_RESTORE_ATTEMPTS });
    process.env[FLAG] = "true";

    let restoreCalls = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => null,
      runRestore: async () => {
        restoreCalls += 1;
      },
    });

    expect(restoreCalls).toBe(0);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("failed");
    expect(archive.lastError.code).toBe("retry_limit_exceeded");
  });

  it("restore throws: failed/restore_failed, original error content never stored", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://secret-user:hunter2@10.0.0.5/db",
      backupDir: "/private/backups",
      homeDir,
      queryJournalEntry: async () => null,
      runRestore: async () => {
        throw new Error("connection string postgres://secret-user:hunter2@10.0.0.5/db failed at /private/backups/x.sql");
      },
    });

    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("failed");
    expect(archive.lastError).toEqual({
      code: "restore_failed",
      message: "Database restore failed; manual review required",
    });
    const archiveRaw = fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8");
    expect(archiveRaw.includes("secret-user")).toBe(false);
    expect(archiveRaw.includes("hunter2")).toBe(false);
    expect(archiveRaw.includes("/private/backups")).toBe(false);
  });

  it("after restore call, journal absent: failed/journal_missing_after_restore", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    let restoreCalls = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => null,
      runRestore: async () => {
        restoreCalls += 1;
      },
    });

    expect(restoreCalls).toBe(1);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("failed");
    expect(archive.lastError.code).toBe("journal_missing_after_restore");
  });

  it("after restore call, journal mismatched: failed/journal_mismatch", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    let journalCallCount = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => {
        journalCallCount += 1;
        if (journalCallCount === 1) return null;
        return {
          jobId: "job-1",
          backupId: "wrong-backup.sql.gz",
          manifestSha256: "f".repeat(64),
          completedAt: new Date().toISOString(),
        };
      },
      runRestore: async () => undefined,
    });

    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("failed");
    expect(archive.lastError.code).toBe("journal_mismatch");
  });

  it("after restore call, journal has same backupId/manifestSha256 but a different jobId: journal_mismatch, never succeeded", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    let restoreCalls = 0;
    let journalCallCount = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => {
        journalCallCount += 1;
        if (journalCallCount === 1) return null;
        return {
          jobId: "some-other-job-id",
          backupId: "paperclip-test.sql.gz",
          manifestSha256: "a".repeat(64),
          completedAt: new Date().toISOString(),
        };
      },
      runRestore: async () => {
        restoreCalls += 1;
      },
    });

    expect(restoreCalls).toBe(1);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("failed");
    expect(archive.lastError.code).toBe("journal_mismatch");
  });

  it("after restore call, journal matches exactly: succeeded, runRestore called exactly once", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    let restoreCalls = 0;
    let journalCallCount = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => {
        journalCallCount += 1;
        if (journalCallCount === 1) return null;
        return VALID_JOURNAL_MATCH;
      },
      runRestore: async () => {
        restoreCalls += 1;
      },
    });

    expect(restoreCalls).toBe(1);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("succeeded");
  });

  it("existing archive with identical 5 identity fields: idempotent success, archive not rewritten, slot freed", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    const archiveDir = path.join(restoreJobsDir(homeDir), "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const preExisting = {
      version: 1,
      jobId: "job-1",
      backupId: "paperclip-test.sql.gz",
      manifestSha256: "a".repeat(64),
      state: "succeeded",
      requestedBy: "test-actor",
      requestedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      restoreAttempts: 0,
      lastError: null,
    };
    fs.writeFileSync(archiveFilePath(homeDir, "job-1"), JSON.stringify(preExisting, null, 2), "utf8");

    let writeArchiveCalls = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => VALID_JOURNAL_MATCH,
      writeArchiveFile: async () => {
        writeArchiveCalls += 1;
      },
    });

    expect(writeArchiveCalls).toBe(0);
    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(false);
    const archiveAfter = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archiveAfter.updatedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(fs.existsSync(lockDirPath(homeDir))).toBe(false);
  });

  it("existing archive with mismatched identity: terminal_archive_conflict, active-job and lock preserved", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger as never);

    const archiveDir = path.join(restoreJobsDir(homeDir), "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const conflicting = {
      version: 1,
      jobId: "job-1",
      backupId: "a-completely-different-backup.sql.gz",
      manifestSha256: "0".repeat(64),
      state: "succeeded",
      requestedBy: "test-actor",
      requestedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      restoreAttempts: 0,
      lastError: null,
    };
    fs.writeFileSync(archiveFilePath(homeDir, "job-1"), JSON.stringify(conflicting, null, 2), "utf8");

    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => VALID_JOURNAL_MATCH,
    });

    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(true);
    const job = readActiveJobRaw(homeDir);
    expect(job?.state).toBe("shutting_down");
    expect(fs.existsSync(lockDirPath(homeDir))).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith({ jobId: "job-1", code: "terminal_archive_conflict" });
  });

  it("corrupted existing archive JSON: terminal_archive_conflict, active-job and lock preserved", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";

    const archiveDir = path.join(restoreJobsDir(homeDir), "archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(archiveFilePath(homeDir, "job-1"), "{ not valid json", "utf8");

    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => VALID_JOURNAL_MATCH,
    });

    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(true);
    expect(fs.existsSync(lockDirPath(homeDir))).toBe(true);
  });

  it("archive write fails (injected): terminal_archive_write_ambiguous, active-job and lock preserved, original error never logged", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger as never);

    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => VALID_JOURNAL_MATCH,
      writeArchiveFile: async () => {
        throw new Error("injected: disk full at /var/secret/archives");
      },
    });

    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(true);
    const job = readActiveJobRaw(homeDir);
    expect(job?.state).toBe("shutting_down");
    expect(fs.existsSync(lockDirPath(homeDir))).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith({ jobId: "job-1", code: "terminal_archive_write_ambiguous" });
    const loggedArgs = JSON.stringify(errorSpy.mock.calls);
    expect(loggedArgs.includes("disk full")).toBe(false);
    expect(loggedArgs.includes("/var/secret/archives")).toBe(false);
  });

  it("active-job removal fails for a reason other than ENOENT (injected): active_job_cleanup_ambiguous, both preserved", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger as never);

    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => VALID_JOURNAL_MATCH,
      removeActiveJobFile: async () => {
        throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      },
    });

    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(true);
    const job = readActiveJobRaw(homeDir);
    expect(job?.state).toBe("shutting_down");
    expect(fs.existsSync(lockDirPath(homeDir))).toBe(true);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("succeeded");
    expect(errorSpy).toHaveBeenCalledWith({ jobId: "job-1", code: "active_job_cleanup_ambiguous" });
  });

  it("an unexpected error in the mid-flow restoring write does not escape, preserves active-job and lock, never calls restore", async () => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: 0 });
    process.env[FLAG] = "true";
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger as never);

    let restoreCalls = 0;
    await expect(
      resumeDatabaseRestoreIfNeeded({
        connectionString: "postgres://example/db",
        backupDir: "/backups",
        homeDir,
        queryJournalEntry: async () => null,
        writeJobFile: async () => {
          throw new Error("injected: unexpected write failure with secret token abc123xyz");
        },
        runRestore: async () => {
          restoreCalls += 1;
        },
      }),
    ).resolves.toBeUndefined();

    expect(restoreCalls).toBe(0);
    expect(fs.existsSync(lockDirPath(homeDir))).toBe(true);
    const job = readActiveJobRaw(homeDir);
    expect(job?.state).toBe("shutting_down");
    expect(errorSpy).toHaveBeenCalledWith({ jobId: "job-1", code: "restore_resume_unexpected_error" });
    const loggedArgs = JSON.stringify(errorSpy.mock.calls);
    expect(loggedArgs.includes("secret token")).toBe(false);
    expect(loggedArgs.includes("abc123xyz")).toBe(false);
  });

  it("legacy job file with no restoreAttempts field at all: treated as 0, restore proceeds", async () => {
    const homeDir = createTempHomeDir();
    const dir = restoreJobsDir(homeDir);
    fs.mkdirSync(dir, { recursive: true });
    const legacyJob = {
      version: 1,
      jobId: "job-1",
      backupId: "paperclip-test.sql.gz",
      manifestSha256: "a".repeat(64),
      state: "shutting_down",
      requestedBy: "test-actor",
      requestedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      // restoreAttempts intentionally absent -- Batch1 shape.
    };
    fs.writeFileSync(activeJobFilePath(homeDir), JSON.stringify(legacyJob, null, 2), "utf8");
    process.env[FLAG] = "true";

    let restoreCalls = 0;
    let journalCallCount = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => {
        journalCallCount += 1;
        if (journalCallCount === 1) return null;
        return VALID_JOURNAL_MATCH;
      },
      runRestore: async () => {
        restoreCalls += 1;
      },
    });

    expect(restoreCalls).toBe(1);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("succeeded");
    expect(archive.restoreAttempts).toBe(1);
  });

  it.each([
    ["negative integer", -1],
    ["non-integer", 1.5],
    ["string", "2"],
    ["NaN", Number.NaN],
  ])("restoreAttempts is invalid (%s): fail-closed, never calls restore", async (_label, invalidValue) => {
    const homeDir = createTempHomeDir();
    writeActiveJob(homeDir, { state: "shutting_down", restoreAttempts: invalidValue as unknown });
    process.env[FLAG] = "true";

    let restoreCalls = 0;
    await resumeDatabaseRestoreIfNeeded({
      connectionString: "postgres://example/db",
      backupDir: "/backups",
      homeDir,
      queryJournalEntry: async () => null,
      runRestore: async () => {
        restoreCalls += 1;
      },
    });

    expect(restoreCalls).toBe(0);
    const archive = JSON.parse(fs.readFileSync(archiveFilePath(homeDir, "job-1"), "utf8"));
    expect(archive.state).toBe("failed");
    expect(archive.lastError.code).toBe("retry_limit_exceeded");
  });
});
