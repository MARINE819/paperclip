import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { AIOfficeStatus, SupervisorStatus } from "@paperclipai/shared";
import { serverVersion } from "../version.js";
import {
  inspectDatabaseBackupHealth,
  type InspectDatabaseBackupHealthOptions,
} from "./database-backup-health.js";

export type PidLiveness = "alive" | "dead" | "unknown";

export interface AIOfficeStatusServiceOptions {
  instanceRoot?: string;
  databaseUrl?: string;
  listenHost?: string;
  listenPort?: number;
  databaseBackupHealth?: InspectDatabaseBackupHealthOptions;
  isApiHealthy?: boolean;
  killProcess?: (pid: number, signal: number) => void;
  now?: () => Date;
}

export function sanitizeDatabaseUrl(rawUrl: string | undefined, fallbackPort = 54329): string {
  if (!rawUrl) {
    return `postgres://paperclip:***@127.0.0.1:${fallbackPort}/paperclip`;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "postgres://***@***";
  }
}

function resolveInstanceRoot(custom?: string): string {
  if (custom?.trim()) return custom.trim();
  if (process.env.PAPERCLIP_INSTANCE_ROOT?.trim()) return process.env.PAPERCLIP_INSTANCE_ROOT.trim();
  return path.join(os.homedir(), ".paperclip", "instances", "default");
}

export function checkPidLiveness(
  pid: number,
  killProcess: (pid: number, signal: number) => void = (p, s) => process.kill(p, s),
): PidLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  try {
    killProcess(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      // EPERM on Windows/POSIX means process exists in OS process table,
      // but current user lacks query/signal permission (e.g. cross-account service).
      return "alive";
    }
    if (code === "ESRCH") {
      // No such process in OS process table.
      return "dead";
    }
    return "unknown";
  }
}

function readTailUtf8(filePath: string, maxBytes = 16 * 1024): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size === 0) return "";
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

interface SupervisorDiagnosticsEvent {
  at?: string;
  event?: string;
  pid?: number;
  [key: string]: unknown;
}

function resolveSupervisorUptime(
  logsDir: string,
  pid: number,
  pidFilePath: string,
  nowMs: number,
): number {
  // 1. Check supervisor-diagnostics.jsonl for actual "process_loaded" event matching pid
  const diagPath = path.join(logsDir, "supervisor-diagnostics.jsonl");
  const diagContent = readTailUtf8(diagPath, 16 * 1024);
  if (diagContent) {
    const lines = diagContent.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line) continue;
      try {
        const item = JSON.parse(line) as SupervisorDiagnosticsEvent;
        if (item.event === "process_loaded" && item.pid === pid && item.at) {
          const loadedAt = Date.parse(item.at);
          if (!Number.isNaN(loadedAt) && loadedAt <= nowMs) {
            return Math.max(0, Math.floor((nowMs - loadedAt) / 1000));
          }
        }
      } catch {}
    }
  }

  // 2. Check control-plane-lifecycle.jsonl for actual "supervisor_started" event matching pid
  const lifecyclePath = path.join(logsDir, "control-plane-lifecycle.jsonl");
  const lifecycleContent = readTailUtf8(lifecyclePath, 32 * 1024);
  if (lifecycleContent) {
    const lines = lifecycleContent.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line) continue;
      try {
        const item = JSON.parse(line) as SupervisorDiagnosticsEvent;
        if (item.event === "supervisor_started" && item.pid === pid && item.at) {
          const startedAt = Date.parse(item.at);
          if (!Number.isNaN(startedAt) && startedAt <= nowMs) {
            return Math.max(0, Math.floor((nowMs - startedAt) / 1000));
          }
        }
      } catch {}
    }
  }

  // 3. Defensive fallback: control-plane-supervisor.pid mtimeMs
  try {
    if (fs.existsSync(pidFilePath)) {
      const stat = fs.statSync(pidFilePath);
      return Math.max(0, Math.floor((nowMs - stat.mtimeMs) / 1000));
    }
  } catch {}

  return 0;
}

interface RecoveryStateFile {
  attempts: number;
  nextAttemptAt: number;
}

function checkActiveRecovery(
  logsDir: string,
  pid: number,
  nowMs: number,
  isDegraded: boolean,
): boolean {
  const recoveryStatePath = path.join(logsDir, "control-plane-recovery-state.json");
  if (!fs.existsSync(recoveryStatePath)) return false;

  let state: RecoveryStateFile | null = null;
  let mtimeMs = 0;
  try {
    const stat = fs.statSync(recoveryStatePath);
    mtimeMs = stat.mtimeMs;
    state = JSON.parse(fs.readFileSync(recoveryStatePath, "utf8")) as RecoveryStateFile;
  } catch {
    return false;
  }

  if (!state || typeof state.attempts !== "number" || typeof state.nextAttemptAt !== "number") {
    return false;
  }

  // Guard against stale state: must be fresh within 5 minutes (300,000 ms)
  const isFresh = nowMs >= mtimeMs ? nowMs - mtimeMs < 300_000 : mtimeMs - nowMs < 60_000;
  const hasActiveRecoverySignal = state.attempts > 0 || state.nextAttemptAt > nowMs;

  if (!isFresh || !hasActiveRecoverySignal) {
    return false;
  }

  // If system is currently degraded (API down or DB unreachable), recovery is active!
  if (isDegraded) {
    return true;
  }

  // If system is answering healthy right now, verify if lifecycle log indicates an unresolved recovery action
  const lifecyclePath = path.join(logsDir, "control-plane-lifecycle.jsonl");
  const lifecycleContent = readTailUtf8(lifecyclePath, 16 * 1024);
  if (lifecycleContent) {
    const lines = lifecycleContent.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      if (!line) continue;
      try {
        const item = JSON.parse(line) as SupervisorDiagnosticsEvent;
        if (item.event === "recovery_succeeded" || item.event === "supervisor_started") {
          // Recovery finished or fresh restart
          return false;
        }
        if (
          item.event === "recovery_attempt" ||
          item.event === "runtime_start_requested" ||
          item.event === "recovery_cycle_scheduled"
        ) {
          // Active recovery action in progress
          return true;
        }
      } catch {}
    }
  }

  return false;
}

export async function getAIOfficeStatus(
  db?: Db,
  options: AIOfficeStatusServiceOptions = {},
): Promise<AIOfficeStatus> {
  const now = options.now ? options.now() : new Date();
  const nowMs = now.getTime();
  const timestamp = now.toISOString();

  // 1. Probe Database
  let dbStatus: "healthy" | "unreachable" = "unreachable";
  let dbPort = 54329;
  let activeConnections = 0;

  if (db) {
    try {
      await db.execute(sql`SELECT 1`);
      dbStatus = "healthy";

      try {
        const portRes = (await db.execute(sql`SELECT current_setting('port')::int AS port`)) as unknown;
        const rows = Array.isArray(portRes) ? portRes : (portRes as { rows?: unknown[] } | undefined)?.rows;
        const row = rows?.[0] as { port?: unknown } | undefined;
        if (typeof row?.port === "number") {
          dbPort = row.port;
        }
      } catch {}

      try {
        const connRes = (await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity`)) as unknown;
        const rows = Array.isArray(connRes) ? connRes : (connRes as { rows?: unknown[] } | undefined)?.rows;
        const row = rows?.[0] as { count?: unknown } | undefined;
        if (typeof row?.count === "number") {
          activeConnections = row.count;
        }
      } catch {}
    } catch {
      dbStatus = "unreachable";
    }
  }

  const resolvedDbUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const databaseMode = resolvedDbUrl ? "external-postgres" : "embedded-postgres";
  const connectionUrlSanitized = sanitizeDatabaseUrl(resolvedDbUrl, dbPort);

  // 2. Probe Server
  const isApiHealthy = options.isApiHealthy ?? true;
  const serverStatus: "healthy" | "unhealthy" = isApiHealthy ? "healthy" : "unhealthy";
  const listenHost = options.listenHost || process.env.HOST || "127.0.0.1";
  const listenPort = options.listenPort || Number(process.env.PORT) || 3100;

  // 3. Probe Supervisor
  const instanceRoot = resolveInstanceRoot(options.instanceRoot);
  const logsDir = path.join(instanceRoot, "logs");
  const pidFilePath = path.join(logsDir, "control-plane-supervisor.pid");

  let supervisorPid: number | null = null;
  let supervisorStatus: SupervisorStatus = "stopped";
  let uptimeSeconds = 0;

  if (fs.existsSync(pidFilePath)) {
    let rawPid = "";
    try {
      rawPid = fs.readFileSync(pidFilePath, "utf8").trim();
    } catch {
      supervisorStatus = "unknown";
    }

    if (rawPid) {
      const parsedPid = Number(rawPid);
      if (!Number.isInteger(parsedPid) || parsedPid <= 0) {
        supervisorStatus = "unknown";
      } else {
        const liveness = checkPidLiveness(parsedPid, options.killProcess);
        if (liveness === "alive") {
          supervisorPid = parsedPid;
          uptimeSeconds = resolveSupervisorUptime(logsDir, parsedPid, pidFilePath, nowMs);

          const isDegraded = dbStatus === "unreachable" || serverStatus === "unhealthy";
          const isRecovering = checkActiveRecovery(logsDir, parsedPid, nowMs, isDegraded);

          supervisorStatus = isRecovering ? "recovering" : "running";
        } else if (liveness === "dead") {
          supervisorStatus = "stopped";
        } else {
          supervisorStatus = "unknown";
          supervisorPid = parsedPid;
        }
      }
    }
  }

  // 4. Probe Backup
  let backupHealth = {
    enabled: false,
    backupDir: "",
    latestBackupName: null as string | null,
    latestBackupTime: null as string | null,
    status: "ok" as "ok" | "failing",
    databaseBackupMaxAgeHours: 24,
  };

  if (options.databaseBackupHealth) {
    try {
      const inspected = inspectDatabaseBackupHealth(options.databaseBackupHealth);
      backupHealth = {
        enabled: inspected.enabled,
        backupDir: inspected.backupDir,
        latestBackupName: inspected.latestBackup ? path.basename(inspected.latestBackup.path) : null,
        latestBackupTime: inspected.latestBackup?.mtime ?? null,
        status: inspected.status === "ok" ? "ok" : "failing",
        databaseBackupMaxAgeHours: inspected.maxAgeHours,
      };
    } catch {
      backupHealth.status = "failing";
    }
  }

  // 5. Build strict whitelist response
  return {
    timestamp,
    supervisor: {
      status: supervisorStatus,
      pid: supervisorPid,
      uptimeSeconds,
    },
    database: {
      mode: databaseMode,
      status: dbStatus,
      port: dbPort,
      activeConnections,
      connectionUrlSanitized,
    },
    server: {
      status: serverStatus,
      version: serverVersion,
      listenHost,
      listenPort,
    },
    backup: backupHealth,
  };
}
