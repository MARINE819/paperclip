#!/usr/bin/env node
// Disposable-only UAT supervisor.
//
// This is deliberately NOT a modification of, or a shared module with,
// scripts/operations/paperclip-control-plane-supervisor.mjs. That script is
// hard-coded to refuse anything other than the operating default instance
// (instance root, API port 3100, DB port 54329) -- a safety guard this file
// must never weaken, bypass, or depend on. This file implements the exact
// opposite guard: it refuses to start anything that looks like it could be
// the operating default instance.
//
// It only ever manages a single disposable child process that it spawns
// itself. It never signals or touches any PID it did not itself record as
// that child's pid, and it never removes a marker file whose recorded pid
// does not match the one this process itself wrote.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recoveryAction } from "./recovery-policy.mjs";

const OPERATING_DEFAULT_INSTANCE_ID = "default";
const OPERATING_API_PORT = 3100;
const OPERATING_DB_PORT = 54329;

function resolveOperatingDefaultRoot(env = process.env) {
  const userProfile = typeof env.USERPROFILE === "string" ? env.USERPROFILE : "";
  return path.resolve(userProfile, ".paperclip", "instances", "default");
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isAbsoluteNonEmptyPath(value) {
  return typeof value === "string" && value.trim().length > 0 && path.isAbsolute(value);
}

// Case-insensitive containment check (Windows paths), with an exact-match
// short-circuit so "a" is considered "within" "a" itself.
function isPathWithin(candidate, container) {
  const resolvedCandidate = path.resolve(candidate).toLowerCase();
  const resolvedContainer = path.resolve(container).toLowerCase();
  if (resolvedCandidate === resolvedContainer) return true;
  return resolvedCandidate.startsWith(resolvedContainer + path.sep);
}

/**
 * Pure validation -- no filesystem, process, or network side effects. Every
 * one of these checks must pass before this module will ever construct a
 * spawn() call for a disposable child.
 */
export function validateDisposableGuardrails(opts, env = process.env) {
  const {
    instanceId,
    homeDir,
    instanceRoot,
    configPath,
    apiPort,
    dbPort,
    embeddedPostgresDataDir,
    restoreExecutionEnabled,
  } = opts ?? {};

  if (instanceId === OPERATING_DEFAULT_INSTANCE_ID) {
    return { ok: false, reason: "instance_id_is_operating_default" };
  }
  if (typeof instanceId !== "string" || instanceId.trim().length === 0) {
    return { ok: false, reason: "instance_id_missing" };
  }
  if (!isAbsoluteNonEmptyPath(homeDir)) {
    return { ok: false, reason: "home_dir_missing_or_relative" };
  }
  if (!isAbsoluteNonEmptyPath(instanceRoot)) {
    return { ok: false, reason: "instance_root_missing_or_relative" };
  }
  if (!isAbsoluteNonEmptyPath(configPath)) {
    return { ok: false, reason: "config_path_missing_or_relative" };
  }
  if (!isAbsoluteNonEmptyPath(embeddedPostgresDataDir)) {
    return { ok: false, reason: "embedded_postgres_data_dir_missing_or_relative" };
  }
  if (!isValidPort(apiPort)) {
    return { ok: false, reason: "api_port_invalid" };
  }
  if (!isValidPort(dbPort)) {
    return { ok: false, reason: "db_port_invalid" };
  }
  if (apiPort === OPERATING_API_PORT) {
    return { ok: false, reason: "api_port_is_operating_port" };
  }
  if (dbPort === OPERATING_DB_PORT) {
    return { ok: false, reason: "db_port_is_operating_port" };
  }
  if (apiPort === dbPort) {
    return { ok: false, reason: "api_port_equals_db_port" };
  }

  const operatingDefaultRoot = resolveOperatingDefaultRoot(env);
  if (
    isPathWithin(instanceRoot, operatingDefaultRoot)
    || isPathWithin(operatingDefaultRoot, instanceRoot)
  ) {
    return { ok: false, reason: "instance_root_overlaps_operating_default_root" };
  }

  if (!isPathWithin(embeddedPostgresDataDir, instanceRoot)) {
    return { ok: false, reason: "embedded_postgres_data_dir_outside_instance_root" };
  }

  if (restoreExecutionEnabled !== "true") {
    return { ok: false, reason: "restore_execution_not_enabled" };
  }

  return { ok: true };
}

// --- Marker files: identity-checked, never blind deletes ---

export function writeMarkerFile(filePath, pid) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(pid), "utf8");
}

export function readMarkerFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Removes the marker only if its recorded pid matches expectedPid exactly.
// A missing file, an unreadable file, or a mismatched pid all leave the file
// (or its absence) exactly as found -- never a blind unlink.
export function removeMarkerIfMatches(filePath, expectedPid) {
  const current = readMarkerFile(filePath);
  if (current === null || current !== expectedPid) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

// --- Safe, allow-listed logging: fixed fields only, never raw errors ---

export function logSafe(record) {
  const { code, instanceId, apiPort, dbPort, pid } = record ?? {};
  const line = { at: new Date().toISOString(), code };
  if (typeof instanceId === "string") line.instanceId = instanceId;
  if (Number.isInteger(apiPort)) line.apiPort = apiPort;
  if (Number.isInteger(dbPort)) line.dbPort = dbPort;
  if (Number.isInteger(pid)) line.pid = pid;
  console.log(JSON.stringify(line));
}

// --- Process liveness / port probing (same shape as recovery-policy's
// inputs, duplicated here only as thin IO wrappers -- no policy logic) ---

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}

export function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(error.code !== "ECONNREFUSED"));
    socket.setTimeout(2000, () => finish(true));
  });
}

// --- Spawning the disposable child (no shell option is ever passed, and no
// joined command string -- executable and args stay as separate values throughout) ---

export function spawnDisposableChild(input) {
  const { command, args, cwd, env, markerRuntimePath, markerSupervisorPath, supervisorPid } = input;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (!child.pid) {
    throw new Error("disposable child was not assigned a pid");
  }
  writeMarkerFile(markerRuntimePath, child.pid);
  writeMarkerFile(markerSupervisorPath, supervisorPid);
  return child;
}

// --- Cleanup: only ever acts on the exact child/markers this process
// itself created; never a blanket process-kill, never a directory delete ---

export function createCleanupHandler(input) {
  const { getChild, markerRuntimePath, markerSupervisorPath, supervisorPid } = input;
  let alreadyRan = false;
  return function cleanup() {
    if (alreadyRan) return;
    alreadyRan = true;
    const child = getChild();
    if (child && child.pid && isPidAlive(child.pid)) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* best-effort; nothing else to do if this fails */
      }
    }
    removeMarkerIfMatches(markerRuntimePath, child ? child.pid : null);
    removeMarkerIfMatches(markerSupervisorPath, supervisorPid);
  };
}

// --- Real-world health probes (used only by the real CLI entrypoint below;
// tests inject their own fakes instead of calling these) ---

function resolveRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export async function defaultApiReady(apiPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/health/ready`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body.status === "ready";
  } catch {
    return false;
  }
}

export async function defaultDbReady(dbPort) {
  try {
    const { createRequire } = await import("node:module");
    const requireFromDb = createRequire(path.join(resolveRepoRoot(), "packages", "db", "package.json"));
    const postgres = requireFromDb("postgres");
    const sql = postgres(`postgres://paperclip:paperclip@127.0.0.1:${dbPort}/paperclip`, {
      max: 1,
      connect_timeout: 5,
      idle_timeout: 1,
      onnotice: () => {},
    });
    try {
      const rows = await sql`select 1 as ready`;
      return Number(rows[0]?.ready) === 1;
    } finally {
      await sql.end({ timeout: 1 }).catch(() => undefined);
    }
  } catch {
    return false;
  }
}

// --- CLI entrypoint (real invocation only; never exercised by tests) ---

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const opts = {
    instanceId: args["instance-id"],
    homeDir: args["home"],
    instanceRoot: args["instance-root"],
    configPath: args["config"],
    apiPort: Number(args["api-port"]),
    dbPort: Number(args["db-port"]),
    embeddedPostgresDataDir: args["embedded-postgres-data-dir"],
    restoreExecutionEnabled: args["restore-execution-enabled"],
  };

  const validation = validateDisposableGuardrails(opts);
  if (!validation.ok) {
    logSafe({ code: `guard_rejected_${validation.reason}`, instanceId: opts.instanceId });
    process.exitCode = 1;
    return;
  }

  const repo = resolveRepoRoot();
  const command = process.execPath;
  const commandArgs = [
    path.join(repo, "cli", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repo, "cli", "src", "index.ts"),
    "run",
    "--instance",
    opts.instanceId,
    "--force",
  ];

  // Only the variables the disposable child actually needs -- never a copy
  // of this (or any other) process's full environment.
  const childEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PAPERCLIP_HOME: opts.homeDir,
    PAPERCLIP_INSTANCE_ID: opts.instanceId,
    PAPERCLIP_INSTANCE_ROOT: opts.instanceRoot,
    PAPERCLIP_CONFIG: opts.configPath,
    PORT: String(opts.apiPort),
    PAPERCLIP_DB_RESTORE_EXECUTION_ENABLED: opts.restoreExecutionEnabled,
  };

  const markerRuntimePath = path.join(opts.instanceRoot, "logs", "control-plane-runtime.pid");
  const markerSupervisorPath = path.join(opts.instanceRoot, "logs", "control-plane-supervisor.pid");

  let child = spawnDisposableChild({
    command,
    args: commandArgs,
    cwd: repo,
    env: childEnv,
    markerRuntimePath,
    markerSupervisorPath,
    supervisorPid: process.pid,
  });
  logSafe({ code: "disposable_child_started", instanceId: opts.instanceId, apiPort: opts.apiPort, dbPort: opts.dbPort, pid: child.pid });

  const cleanup = createCleanupHandler({
    getChild: () => child,
    markerRuntimePath,
    markerSupervisorPath,
    supervisorPid: process.pid,
  });
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  let attempts = 0;
  let nextAttemptAt = 0;
  const timer = setInterval(async () => {
    const apiOk = await defaultApiReady(opts.apiPort);
    const dbOk = await defaultDbReady(opts.dbPort);
    const runtimeAlive = isPidAlive(child.pid);
    const appPortOpen = await portOpen(opts.apiPort);
    const dbPortOpen = await portOpen(opts.dbPort);

    if (apiOk && dbOk) {
      attempts = 0;
      nextAttemptAt = 0;
      return;
    }

    const action = recoveryAction({
      apiReady: apiOk,
      dbReady: dbOk,
      runtimeAlive,
      appPortOpen,
      dbPortOpen,
      attempts,
      now: Date.now(),
      nextAttemptAt,
    });

    if (action === "start") {
      attempts += 1;
      nextAttemptAt = Date.now() + 120_000;
      child = spawnDisposableChild({
        command,
        args: commandArgs,
        cwd: repo,
        env: childEnv,
        markerRuntimePath,
        markerSupervisorPath,
        supervisorPid: process.pid,
      });
      logSafe({ code: "disposable_child_restarted", instanceId: opts.instanceId, pid: child.pid });
    } else if (action === "exhausted") {
      attempts = 0;
      nextAttemptAt = Date.now() + 300_000;
      logSafe({ code: "disposable_recovery_cycle_paused", instanceId: opts.instanceId });
    }
  }, 5_000);
  timer.unref();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
