import { existsSync, openSync, closeSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// A truncated or empty gzip stream (the exact shape left behind by a backup
// whose compression step was interrupted mid-write) still has a technically
// valid gzip header — an empty gzip archive is a legal gzip file. Size alone
// is what distinguishes it from a real database dump: every backup this
// deployment has ever produced, even of a near-empty database, has been
// multiple megabytes. A file below this floor is treated as not a real
// backup regardless of its extension.
const MIN_VALID_BACKUP_SIZE_BYTES = 4096;
const GZIP_MAGIC_BYTES = [0x1f, 0x8b];

export type DatabaseBackupHealthWarningCode =
  | "database_backup_check_failed"
  | "database_backup_last_failure"
  | "database_backup_missing"
  | "database_backup_stale";

export type DatabaseBackupHealthWarning = {
  code: DatabaseBackupHealthWarningCode;
  message: string;
};

export type DatabaseBackupHealthStatus = {
  enabled: boolean;
  status: "ok" | "warning";
  backupDir: string;
  maxAgeHours: number;
  latestBackup: {
    name: string;
    path: string;
    mtime: string;
    ageHours: number;
    sizeBytes: number;
  } | null;
  /**
   * A newer-than-latestBackup artifact left behind by a backup that did not
   * finish successfully — most commonly the raw, uncompressed .sql from a
   * run whose gzip-compression step failed or timed out after the dump
   * itself completed. Present only when such an artifact exists and is
   * newer than the true latestBackup; never a substitute for a real backup.
   */
  latestRecoveryArtifact: {
    name: string;
    path: string;
    mtime: string;
    ageHours: number;
    sizeBytes: number;
    reason: string;
  } | null;
  lastFailure: {
    path: string;
    mtime: string;
    message: string;
  } | null;
  warnings: DatabaseBackupHealthWarning[];
};

export type InspectDatabaseBackupHealthOptions = {
  enabled: boolean;
  backupDir: string;
  maxAgeHours: number;
  alertFile?: string;
  alertFiles?: string[];
  now?: Date;
};

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function alertFileCandidates(opts: InspectDatabaseBackupHealthOptions) {
  return [...new Set([
    opts.alertFile,
    ...(opts.alertFiles ?? []),
    join(opts.backupDir, "db-backup-to-s3.failure"),
    resolve(opts.backupDir, "..", "db-backup-to-s3.failure"),
  ].filter((value): value is string => Boolean(value)))];
}

function readLastFailure(alertFiles: string[]) {
  const failures = alertFiles
    .filter((alertFile) => existsSync(alertFile))
    .map((alertFile) => {
      const stat = statSync(alertFile);
      const message = readFileSync(alertFile, "utf8").trim().split(/\r?\n/)[0] ||
        "Database backup failure marker is present.";
      return {
        path: alertFile,
        mtime: new Date(stat.mtimeMs).toISOString(),
        mtimeMs: stat.mtimeMs,
        message,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = failures[0];
  if (!latest) return null;
  return {
    path: latest.path,
    mtime: latest.mtime,
    message: latest.message,
  };
}

function hasGzipMagicBytes(filePath: string): boolean {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(2);
    const bytesRead = readSync(fd, header, 0, 2, 0);
    return bytesRead === 2 && header[0] === GZIP_MAGIC_BYTES[0] && header[1] === GZIP_MAGIC_BYTES[1];
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

// A file only counts as a genuine backup when it is large enough to plausibly
// hold real dump content AND actually starts with the gzip magic bytes.
// Neither check alone is enough: an interrupted compression can leave behind
// a technically-valid-but-empty gzip stream (passes the magic check, fails
// the size floor), so both must hold.
function isValidBackupFile(stat: { size: number }, fullPath: string): boolean {
  return stat.size >= MIN_VALID_BACKUP_SIZE_BYTES && hasGzipMagicBytes(fullPath);
}

function toBackupEntry(fullPath: string, mtimeMs: number, sizeBytes: number, nowMs: number) {
  return {
    name: basename(fullPath),
    path: fullPath,
    mtime: new Date(mtimeMs).toISOString(),
    ageHours: roundHours((nowMs - mtimeMs) / 3_600_000),
    sizeBytes,
  };
}

function findLatestBackup(backupDir: string, nowMs: number) {
  if (!existsSync(backupDir)) return { latestBackup: null, latestRecoveryArtifact: null };

  const allEntries = readdirSync(backupDir);
  const candidates = allEntries
    .filter((name) => name.endsWith(".sql.gz"))
    .map((name) => {
      const fullPath = join(backupDir, name);
      const stat = statSync(fullPath);
      return { fullPath, name, stat };
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const newestCandidate = candidates[0] ?? null;
  const latestValid = candidates.find((entry) => isValidBackupFile(entry.stat, entry.fullPath)) ?? null;

  const latestBackup = latestValid
    ? toBackupEntry(latestValid.fullPath, latestValid.stat.mtimeMs, latestValid.stat.size, nowMs)
    : null;

  // A recovery artifact is only worth surfacing when the newest .gz on disk
  // is itself the broken one (otherwise there is nothing to point at beyond
  // the good backup already reported above).
  let latestRecoveryArtifact: DatabaseBackupHealthStatus["latestRecoveryArtifact"] = null;
  if (newestCandidate && newestCandidate !== latestValid && !isValidBackupFile(newestCandidate.stat, newestCandidate.fullPath)) {
    const siblingSqlName = newestCandidate.name.replace(/\.gz$/, "");
    const siblingSqlPath = join(backupDir, siblingSqlName);
    if (siblingSqlName !== newestCandidate.name && existsSync(siblingSqlPath)) {
      const siblingStat = statSync(siblingSqlPath);
      latestRecoveryArtifact = {
        ...toBackupEntry(siblingSqlPath, siblingStat.mtimeMs, siblingStat.size, nowMs),
        reason: `Compressed backup ${newestCandidate.name} is invalid or truncated; this uncompressed dump from the same run is the actual recovery point.`,
      };
    }
  }

  return { latestBackup, latestRecoveryArtifact };
}

export function inspectDatabaseBackupHealth(
  opts: InspectDatabaseBackupHealthOptions,
): DatabaseBackupHealthStatus {
  const warnings: DatabaseBackupHealthWarning[] = [];
  const now = opts.now ?? new Date();
  const maxAgeHours = Math.max(1, opts.maxAgeHours);

  let latestBackup: DatabaseBackupHealthStatus["latestBackup"] = null;
  let latestRecoveryArtifact: DatabaseBackupHealthStatus["latestRecoveryArtifact"] = null;
  let lastFailure: DatabaseBackupHealthStatus["lastFailure"] = null;

  try {
    ({ latestBackup, latestRecoveryArtifact } = findLatestBackup(opts.backupDir, now.getTime()));
    lastFailure = readLastFailure(alertFileCandidates(opts));

    if (!latestBackup) {
      warnings.push({
        code: "database_backup_missing",
        message: `No .sql.gz database backups found in ${opts.backupDir}.`,
      });
    } else if (latestBackup.ageHours > maxAgeHours) {
      warnings.push({
        code: "database_backup_stale",
        message: `Latest database backup is ${latestBackup.ageHours}h old, exceeding ${maxAgeHours}h.`,
      });
    }

    if (lastFailure) {
      warnings.push({
        code: "database_backup_last_failure",
        message: lastFailure.message,
      });
    }
  } catch (error) {
    warnings.push({
      code: "database_backup_check_failed",
      message: `Database backup health check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return {
    enabled: opts.enabled,
    status: warnings.length > 0 ? "warning" : "ok",
    backupDir: opts.backupDir,
    maxAgeHours,
    latestBackup,
    latestRecoveryArtifact,
    lastFailure,
    warnings,
  };
}
