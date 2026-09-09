export type SupervisorStatus = "running" | "stopped" | "recovering" | "unknown";

export interface AIOfficeStatus {
  timestamp: string;
  supervisor: {
    status: SupervisorStatus;
    pid: number | null;
    uptimeSeconds: number;
  };
  database: {
    mode: "embedded-postgres" | "external-postgres";
    status: "healthy" | "unreachable";
    port: number;
    activeConnections: number;
    connectionUrlSanitized: string;
  };
  server: {
    status: "healthy" | "unhealthy";
    version: string;
    listenHost: string;
    listenPort: number;
  };
  backup: {
    enabled: boolean;
    backupDir: string;
    latestBackupName: string | null;
    latestBackupTime: string | null;
    status: "ok" | "failing";
    databaseBackupMaxAgeHours: number;
  };
}
