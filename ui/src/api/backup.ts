export type DatabaseBackupHealthWarningCode =
  | "database_backup_check_failed"
  | "database_backup_last_failure"
  | "database_backup_missing"
  | "database_backup_stale";

export type DatabaseBackupHealthWarning = {
  code: DatabaseBackupHealthWarningCode;
  message: string;
};

export type DatabaseBackupArtifactInfo = {
  name: string;
  path: string;
  mtime: string;
  ageHours: number;
  sizeBytes: number;
};

export type DatabaseBackupRecoveryArtifactInfo = DatabaseBackupArtifactInfo & {
  reason: string;
};

export type DatabaseBackupLastFailureInfo = {
  path: string;
  mtime: string;
  message: string;
};

export type DatabaseBackupHealthStatus = {
  enabled: boolean;
  status: "ok" | "warning";
  backupDir: string;
  maxAgeHours: number;
  latestBackup: DatabaseBackupArtifactInfo | null;
  latestRecoveryArtifact: DatabaseBackupRecoveryArtifactInfo | null;
  lastFailure: DatabaseBackupLastFailureInfo | null;
  warnings: DatabaseBackupHealthWarning[];
};

export type ManualBackupResult = {
  trigger: "manual" | "scheduled";
  backupDir: string;
  retention: {
    retentionDays: number;
    cleanedCount?: number;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  backupFile?: string;
  sizeBytes?: number;
};

export const backupApi = {
  getHealth: async (): Promise<DatabaseBackupHealthStatus> => {
    const res = await fetch("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to load backup health (${res.status})`);
    }
    const data = await res.json();
    if (data.databaseBackup) {
      return data.databaseBackup as DatabaseBackupHealthStatus;
    }
    return {
      enabled: false,
      status: "ok",
      backupDir: "",
      maxAgeHours: 24,
      latestBackup: null,
      latestRecoveryArtifact: null,
      lastFailure: null,
      warnings: [],
    };
  },
  runManualBackup: async (): Promise<ManualBackupResult> => {
    // REAL_PRODUCTION_POST_ENABLED=NO: Phase 1 Safe Mode protects production database.
    throw new Error("안전 모드(Safe Mode) 보호: 운영 수동 백업 API 호출이 비활성화되어 있습니다.");
  },
};
