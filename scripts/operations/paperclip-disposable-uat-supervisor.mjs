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

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { recoveryAction } from "./recovery-policy.mjs";

const execFileAsync = promisify(execFile);

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
  const { command, args, cwd, env, markerRuntimePath, markerSupervisorPath, supervisorPid, instanceId } = input;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  // An 'error' event with no listener throws and crashes this process; a
  // spawn-level failure (e.g. ENOENT) must be logged, never left unhandled.
  child.on("error", () => {
    logSafe({ code: "disposable_child_spawn_error", instanceId, pid: child.pid });
  });
  if (!child.pid) {
    throw new Error("disposable child was not assigned a pid");
  }
  writeMarkerFile(markerRuntimePath, child.pid);
  writeMarkerFile(markerSupervisorPath, supervisorPid);
  return child;
}

// --- Verified runtime pid resolution -----------------------------------
//
// child.pid above is only the pid of the bootstrap process this supervisor
// itself spawned (node running tsx's cli.mjs). tsx's own CLI internally
// re-spawns itself one level deeper to apply its ESM loader hook, so the
// pid that actually binds apiPort -- and that the real server reports as
// its own process.pid -- is a grandchild, not child.pid. "the api port is
// open" is therefore never sufficient on its own: some unrelated process
// could also be bound to it (a stale leftover, or coincidence), so the
// candidate pid's identity is verified two ways before it is ever trusted:
// (1) it must be a process-tree descendant of the bootstrap pid this
//     supervisor spawned, and
// (2) its own OS-reported creation time must be at/after the moment this
//     supervisor issued spawn(), which rules out a stale pid-reused
//     process that happened to already be sitting on the port.
// Only once both hold is the runtime marker (re)written -- with the real
// pid, never the bootstrap pid.

const DEFAULT_MAX_ANCESTRY_HOPS = 6;
const CLOCK_SKEW_TOLERANCE_MS = 5_000;

// Pure parse of `netstat -ano` output; no IO.
export function parseNetstatPortOwnerPid(stdout, port) {
  const needle = `127.0.0.1:${port}`;
  const lines = typeof stdout === "string" ? stdout.split(/\r?\n/) : [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.toUpperCase().startsWith("TCP")) continue;
    const columns = trimmed.split(/\s+/);
    if (columns.length < 5) continue;
    const [, local, , state, pidColumn] = columns;
    if (state !== "LISTENING") continue;
    if (local !== needle) continue;
    const pid = Number(pidColumn);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

// IO wrapper: execFileAsync is injected so tests never shell out for real.
export async function getPortOwnerPid(port, execFileAsyncFn) {
  try {
    const { stdout } = await execFileAsyncFn("netstat", ["-ano", "-p", "TCP"]);
    return parseNetstatPortOwnerPid(stdout, port);
  } catch {
    return null;
  }
}

// Pure parse of a single "<parentPid>|<creationDate ISO-ish>" line; no IO.
export function parseWin32ProcessInfo(stdout) {
  const trimmed = typeof stdout === "string" ? stdout.trim() : "";
  if (!trimmed) return null;
  const sep = trimmed.indexOf("|");
  if (sep === -1) return null;
  const parentPid = Number(trimmed.slice(0, sep));
  const creationEpochMs = Date.parse(trimmed.slice(sep + 1));
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  if (Number.isNaN(creationEpochMs)) return null;
  return { parentPid, creationEpochMs };
}

// Query ParentProcessId and CreationDate via Win32_Process.
// Use a validated PID with execFile arguments; never invoke a shell.
export async function getProcessInfo(pid, execFileAsyncFn) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const script =
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
      `if ($p) { Write-Output ($p.ParentProcessId.ToString() + '|' + $p.CreationDate.ToString('o')) }`;
    const { stdout } = await execFileAsyncFn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return parseWin32ProcessInfo(stdout);
  } catch {
    return null;
  }
}

// Walks candidatePid's ParentProcessId chain looking for bootstrapPid,
// bounded by maxHops so an unrelated process (or a lookup that keeps
// returning garbage) can never spin this forever.
export async function isVerifiedDescendant(input) {
  const { candidatePid, bootstrapPid, getProcessInfoFn, maxHops = DEFAULT_MAX_ANCESTRY_HOPS } = input;
  if (candidatePid === bootstrapPid) return true;
  let currentPid = candidatePid;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const info = await getProcessInfoFn(currentPid);
    if (!info) return false;
    if (info.parentPid === bootstrapPid) return true;
    currentPid = info.parentPid;
  }
  return false;
}

// Orchestrator: resolves the real runtime pid and, only once both identity
// checks pass, (re)writes the runtime marker with it. Never writes a guess
// -- a failed verification leaves the decision to the caller (which, in
// main(), removes the stale bootstrap-pid marker rather than let it sit
// there looking like a normal, trustworthy value).
export async function verifyAndRecordRealRuntimePid(input) {
  const {
    apiPort,
    bootstrapPid,
    bootstrapSpawnedAtMs,
    markerRuntimePath,
    getPortOwnerPidFn,
    getProcessInfoFn,
    maxHops = DEFAULT_MAX_ANCESTRY_HOPS,
  } = input;

  const candidatePid = await getPortOwnerPidFn(apiPort);
  if (candidatePid === null) {
    return { ok: false, reason: "port_owner_not_found" };
  }

  if (candidatePid !== bootstrapPid) {
    const descendant = await isVerifiedDescendant({ candidatePid, bootstrapPid, getProcessInfoFn, maxHops });
    if (!descendant) {
      return { ok: false, reason: "port_owner_not_descendant_of_bootstrap", candidatePid };
    }
  }

  const candidateInfo = await getProcessInfoFn(candidatePid);
  if (!candidateInfo) {
    return { ok: false, reason: "candidate_process_info_unavailable", candidatePid };
  }
  if (candidateInfo.creationEpochMs < bootstrapSpawnedAtMs - CLOCK_SKEW_TOLERANCE_MS) {
    return { ok: false, reason: "candidate_predates_bootstrap_spawn", candidatePid };
  }

  writeMarkerFile(markerRuntimePath, candidatePid);
  return { ok: true, pid: candidatePid };
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

// --- Post-failure teardown confirmation --------------------------------
//
// createCleanupHandler's cleanup() is synchronous: child.kill("SIGTERM")
// only issues the signal and returns immediately, it does not wait for the
// child to actually exit. That is fine for the ordinary SIGINT/SIGTERM path
// (the whole supervisor process is about to go away regardless), but it is
// not enough confirmation to report after a runtime-pid verification
// failure. confirmDisposableTeardown polls -- bounded, never escalating
// beyond the single tracked child pid and its own two disposable ports --
// until both the child is gone and apiPort/dbPort are released, or the
// attempt budget runs out (reported honestly, never compensated for by
// widening scope to any other pid or port).

export async function confirmDisposableTeardown(input) {
  const { childPid, apiPort, dbPort, maxAttempts = 20, intervalMs = 250 } = input;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const childAlive = isPidAlive(childPid);
    const apiPortOpen = await portOpen(apiPort);
    const dbPortOpen = await portOpen(dbPort);
    if (!childAlive && !apiPortOpen && !dbPortOpen) {
      return { ok: true, attempts: attempt };
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return { ok: false, attempts: maxAttempts, childAlive: isPidAlive(childPid) };
}

// Bundles the full, non-escalating response to a failed runtime-pid
// verification: log the reason, trigger the existing cleanup handler
// (issues SIGTERM + identity-checked marker removal), then WAIT for the
// tracked child and its ports to actually go away before reporting back.
export async function handleRuntimePidVerificationFailure(input) {
  const { reason, instanceId, childPid, apiPort, dbPort, cleanupFn, maxAttempts, intervalMs } = input;
  logSafe({ code: `runtime_pid_verification_failed_${reason}`, instanceId });
  cleanupFn();
  const teardown = await confirmDisposableTeardown({ childPid, apiPort, dbPort, maxAttempts, intervalMs });
  if (teardown.ok) {
    logSafe({ code: "disposable_teardown_confirmed_after_verification_failure", instanceId });
  } else {
    logSafe({ code: "disposable_teardown_unconfirmed_after_verification_failure", instanceId });
  }
  return teardown;
}

// Tick body wrapped in try/catch so a thrown error (e.g. from spawnChildFn)
// never crashes the whole supervisor process silently.
export async function runSupervisorTick(state, deps) {
  if (state.tickInProgress) {
    return { outcome: "skipped-reentrant" };
  }
  state.tickInProgress = true;

  const {
    instanceId, apiPort, dbPort, markerRuntimePath,
    spawnChildFn, apiReadyFn, dbReadyFn, portOpenFn, isPidAliveFn,
    recoveryActionFn, verifyRuntimePidFn, handleVerificationFailureFn,
    getPortOwnerPidFn, getProcessInfoFn, cleanupFn,
  } = deps;

  try {
    const apiOk = await apiReadyFn(apiPort);
    const dbOk = await dbReadyFn(dbPort);
    const runtimeAlive = isPidAliveFn(state.child.pid);
    const appPortOpen = await portOpenFn(apiPort);
    const dbPortOpen = await portOpenFn(dbPort);

    if (apiOk && dbOk) {
      state.attempts = 0;
      state.nextAttemptAt = 0;

      if (state.verifiedRuntimePid === null) {
        const verification = await verifyRuntimePidFn({
          apiPort,
          bootstrapPid: state.child.pid,
          bootstrapSpawnedAtMs: state.bootstrapSpawnedAtMs,
          markerRuntimePath,
          getPortOwnerPidFn,
          getProcessInfoFn,
        });
        if (verification.ok) {
          state.verifiedRuntimePid = verification.pid;
          logSafe({ code: "runtime_pid_verified", instanceId, pid: verification.pid });
          return { outcome: "verified", pid: verification.pid };
        }
        const teardown = await handleVerificationFailureFn({
          reason: verification.reason,
          instanceId,
          childPid: state.child.pid,
          apiPort,
          dbPort,
          cleanupFn,
        });
        return { outcome: "verification-failed", teardown };
      }
      return { outcome: "healthy" };
    }

    const action = recoveryActionFn({
      apiReady: apiOk,
      dbReady: dbOk,
      runtimeAlive,
      appPortOpen,
      dbPortOpen,
      attempts: state.attempts,
      now: Date.now(),
      nextAttemptAt: state.nextAttemptAt,
    });

    if (action === "start") {
      state.attempts += 1;
      state.nextAttemptAt = Date.now() + 120_000;
      state.child = spawnChildFn();
      state.bootstrapSpawnedAtMs = Date.now();
      state.verifiedRuntimePid = null;
      logSafe({ code: "disposable_child_restarted", instanceId, pid: state.child.pid });
      return { outcome: "restarted", pid: state.child.pid };
    } else if (action === "exhausted") {
      state.attempts = 0;
      state.nextAttemptAt = Date.now() + 300_000;
      logSafe({ code: "disposable_recovery_cycle_paused", instanceId });
      return { outcome: "exhausted" };
    } else if (action === "manual-attention") {
      logSafe({ code: "disposable_manual_attention_required", instanceId });
      return { outcome: "manual-attention" };
    }
    return { outcome: "cooldown" };
  } catch (error) {
    logSafe({ code: "recovery_tick_error", instanceId });
    return { outcome: "tick-error", error };
  } finally {
    state.tickInProgress = false;
  }
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

export async function defaultGetPortOwnerPid(port) {
  return getPortOwnerPid(port, execFileAsync);
}

export async function defaultGetProcessInfo(pid) {
  return getProcessInfo(pid, execFileAsync);
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

  const spawnChildFn = () =>
    spawnDisposableChild({
      command,
      args: commandArgs,
      cwd: repo,
      env: childEnv,
      markerRuntimePath,
      markerSupervisorPath,
      supervisorPid: process.pid,
      instanceId: opts.instanceId,
    });

  const state = {
    child: spawnChildFn(),
    bootstrapSpawnedAtMs: Date.now(),
    verifiedRuntimePid: null,
    tickInProgress: false,
  };
  logSafe({ code: "disposable_child_started", instanceId: opts.instanceId, apiPort: opts.apiPort, dbPort: opts.dbPort, pid: state.child.pid });

  const cleanup = createCleanupHandler({
    getChild: () => state.child,
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

  state.attempts = 0;
  state.nextAttemptAt = 0;
  const deps = {
    instanceId: opts.instanceId,
    apiPort: opts.apiPort,
    dbPort: opts.dbPort,
    markerRuntimePath,
    spawnChildFn,
    apiReadyFn: defaultApiReady,
    dbReadyFn: defaultDbReady,
    portOpenFn: portOpen,
    isPidAliveFn: isPidAlive,
    recoveryActionFn: recoveryAction,
    verifyRuntimePidFn: verifyAndRecordRealRuntimePid,
    handleVerificationFailureFn: handleRuntimePidVerificationFailure,
    getPortOwnerPidFn: defaultGetPortOwnerPid,
    getProcessInfoFn: defaultGetProcessInfo,
    cleanupFn: cleanup,
  };
  const timer = setInterval(async () => {
    const result = await runSupervisorTick(state, deps);
    if (result.outcome === "verification-failed") {
      clearInterval(timer);
      process.exitCode = result.teardown.ok ? 1 : 2;
      process.exit(process.exitCode);
    }
  }, 5_000);
  timer.unref();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
