import net from "node:net";
import { recoveryAction } from "./recovery-policy.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "../..");
const instance = process.env.PAPERCLIP_INSTANCE_ROOT || path.join(process.env.USERPROFILE, ".paperclip", "instances", "default");
const logs = path.join(instance, "logs");
const lifecycle = path.join(logs, "control-plane-lifecycle.jsonl");
const alerts = path.join(logs, "control-plane-alerts.jsonl");
const lock = path.join(logs, "control-plane-supervisor.pid");
const api = process.env.PAPERCLIP_HEALTH_URL || "http://127.0.0.1:3100/api/health/ready";
const dbUrl = process.env.PAPERCLIP_DATABASE_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const requireFromDb = createRequire(path.join(repo, "packages", "db", "package.json"));
const postgres = requireFromDb("postgres");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(logs, { recursive: true });

const TRANSIENT_FS_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
function isTransientFsError(error) {
  return Boolean(error && TRANSIENT_FS_CODES.has(error.code));
}

async function withFsRetry(fn, { maxRetries = 5, baseDelayMs = 25, maxTotalDelayMs = 1000 } = {}) {
  let lastError;
  let totalDelay = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientFsError(error) || attempt === maxRetries || totalDelay >= maxTotalDelayMs) {
        throw error;
      }
      const ms = Math.min(baseDelayMs * (2 ** attempt), maxTotalDelayMs - totalDelay);
      totalDelay += ms;
      await delay(ms);
    }
  }
  throw lastError;
}

function record(file, event, details = {}) {
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
  } catch (error) {
    if (isTransientFsError(error)) {
      (async () => {
        try {
          await withFsRetry(() => {
            fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
          });
        } catch (retryError) {
          if (isTransientFsError(retryError)) {
            try {
              process.stderr.write(`[supervisor] diagnostic log dropped after retries (${retryError.code}): ${event}\n`);
            } catch {}
          } else {
            throw retryError;
          }
        }
      })().catch(() => {});
      return;
    }
    throw error;
  }
}

const runtimeLock = path.join(logs, "control-plane-runtime.pid");
const recoveryState = path.join(logs, "control-plane-recovery-state.json");
let state = { attempts: 0, nextAttemptAt: 0 };
if (fs.existsSync(recoveryState)) state = JSON.parse(fs.readFileSync(recoveryState, "utf8"));
if (!Number.isInteger(state.attempts) || state.attempts < 0 || !Number.isFinite(state.nextAttemptAt)) throw new Error("Invalid recovery state; operator review required");
async function saveState() {
  await withFsRetry(() => {
    fs.writeFileSync(`${recoveryState}.tmp`, JSON.stringify(state));
    fs.renameSync(`${recoveryState}.tmp`, recoveryState);
  });
}
function runtimeAlive() {
  const pid = Number(fs.existsSync(runtimeLock) ? fs.readFileSync(runtimeLock, "utf8") : 0);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(error.code !== "ECONNREFUSED"));
    socket.setTimeout(2000, () => finish(true)); // Uncertainty must block another start.
  });
}
let lastAlert = "";
function alert(code, details = {}) {
  const fingerprint = JSON.stringify({ code, ...details });
  if (fingerprint === lastAlert) return;
  lastAlert = fingerprint;
  record(alerts, code, details);
  if (process.platform === "win32" && process.env.PAPERCLIP_NO_DESKTOP_ALERTS !== "true") {
    spawn("msg.exe", [process.env.USERNAME || "*", `Paperclip ${code}: ${details.component || "control-plane"}`], { stdio: "ignore", windowsHide: true }).once("error", (error) => record(lifecycle, "notification_failed", { message: error.message }));
  }
}

async function apiReady() {
  try {
    const response = await fetch(api, { signal: AbortSignal.timeout(5_000) });
    const body = await response.json();
    return response.ok && body.status === "ready";
  } catch { return false; }
}

async function dbReady() {
  const sql = postgres(dbUrl, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
  try {
    const rows = await sql`select 1 as ready`;
    return Number(rows[0]?.ready) === 1;
  } catch { return false; }
  finally { await sql.end({ timeout: 1 }).catch(() => undefined); }
}

function startRuntime() {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const stdout = fs.openSync(path.join(logs, `service-${stamp}.log`), "a");
  const stderr = fs.openSync(path.join(logs, `service-${stamp}.err.log`), "a");
  // Launch the real Node process directly. A cmd/pnpm wrapper exits early and leaves
  // a stale PID, and Task Scheduler sessions may not have the user's npm PATH.
  const command = process.execPath;
  const args = [path.join(repo, "cli", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repo, "cli", "src", "index.ts"), "run", "--instance", "default", "--force"];
  const child = spawn(command, args, {
    cwd: repo, detached: true, windowsHide: true, stdio: ["ignore", stdout, stderr],
  });
  if (child.pid) fs.writeFileSync(runtimeLock, String(child.pid));
  child.unref();
  record(lifecycle, "runtime_start_requested", {
    pid: child.pid,
    supervisorPid: process.pid,
    detached: true,
    windowsHide: true,
  });
  child.once("error", (error) => record(lifecycle, "runtime_start_error", { message: error.message }));
  child.once("exit", (code, signal) => {
    try { fs.closeSync(stdout); } catch {}
    try { fs.closeSync(stderr); } catch {}
    try { if (Number(fs.readFileSync(runtimeLock, "utf8")) === child.pid) fs.unlinkSync(runtimeLock); } catch {}
    record(lifecycle, "runtime_exit", { pid: child.pid, code, signal });
  });
  return child;
}

async function waitReady(seconds = 90) {
  for (let i = 0; i < seconds / 3; i += 1) {
    if (await apiReady() && await dbReady()) return true;
    await delay(3_000);
  }
  return false;
}

async function once({ recover = true } = {}) {
  const apiOk = await apiReady();
  const dbOk = await dbReady();
  record(lifecycle, "probe", { apiReady: apiOk, databaseReady: dbOk });
  if (apiOk && dbOk) {
    if (state.attempts) {
      state = { attempts: 0, nextAttemptAt: 0 }; await saveState();
      alert("CONTROL_PLANE_RECOVERED", { component: "control-plane" });
    }
    return true;
  }
  if (!recover) return false;
  const action = recoveryAction({ ready: false, runtimeAlive: runtimeAlive(),
    portOpen: (await portOpen(3100)) || (await portOpen(54329)),
    attempts: state.attempts, now: Date.now(), nextAttemptAt: state.nextAttemptAt });
  if (action !== "start") {
    if (action === "exhausted") {
      alert("RECOVERY_CYCLE_PAUSED", { component: "control-plane", retryMinutes: 5 });
      state = { attempts: 0, nextAttemptAt: Date.now() + 300_000 };
      await saveState();
      record(lifecycle, "recovery_cycle_scheduled", { retryMinutes: 5 });
    } else if (action !== "cooldown") {
      alert("MANUAL_ATTENTION_REQUIRED", { component: "control-plane" });
    }
    return false;
  }
  state.attempts += 1;
  state.nextAttemptAt = Date.now() + 120000;
  await saveState(); // Persist before spawning: supervisor restarts do not reset the budget.
  record(lifecycle, "recovery_attempt", { attempt: state.attempts });
  startRuntime();
  if (!(await waitReady())) return false;
  record(lifecycle, "recovery_succeeded", { attempt: state.attempts });
  state = { attempts: 0, nextAttemptAt: 0 }; await saveState();
  alert("CONTROL_PLANE_RECOVERED", { component: "control-plane" });
  return true;
}

async function main() {
  // Fixed Default-only deployment; refuse inherited overrides that could hit Canary.
  const expected = path.join(process.env.USERPROFILE, ".paperclip", "instances", "default");
  if (path.resolve(instance).toLowerCase() !== path.resolve(expected).toLowerCase() ||
      api !== "http://127.0.0.1:3100/api/health/ready" || new URL(dbUrl).port !== "54329" ||
      !["127.0.0.1", "localhost"].includes(new URL(dbUrl).hostname) || process.env.DATABASE_URL ||
      process.env.PAPERCLIP_HOME || process.env.PAPERCLIP_INSTANCE_ID || process.env.PAPERCLIP_CONFIG) {
    throw new Error("Unexpected instance/environment override: refusing automatic startup");
  }
  const existing = Number(await withFsRetry(() => (fs.existsSync(lock) ? fs.readFileSync(lock, "utf8") : 0)));
  if (existing && existing !== process.pid) {
    try { process.kill(existing, 0); return; } catch { /* stale lock */ }
  }
  await withFsRetry(() => fs.writeFileSync(lock, String(process.pid)));
  const cleanup = () => { try { if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.unlinkSync(lock); } catch {} };
  const recordShutdownSignal = (signal) => {
    record(lifecycle, "supervisor_shutdown_signal", {
      signal,
      pid: process.pid,
      parentPid: process.ppid,
      sessionName: process.env.SESSIONNAME || null,
      username: process.env.USERNAME || null,
    });
    cleanup();
    process.exit(0);
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => recordShutdownSignal("SIGINT"));
  process.once("SIGTERM", () => recordShutdownSignal("SIGTERM"));
  record(lifecycle, "supervisor_started", {
    pid: process.pid,
    parentPid: process.ppid,
    sessionName: process.env.SESSIONNAME || null,
    username: process.env.USERNAME || null,
    argv: process.argv.slice(1),
  });
  if (process.argv.includes("--alert-test")) {
    alert("SYNTHETIC_ALERT", { component: "validation", lifecycle });
    return;
  }
  if (!process.argv.includes("--watch")) {
    process.exitCode = (await once({ recover: !process.argv.includes("--no-recover") })) ? 0 : 1;
    return;
  }
  while (true) {
    try {
      await once();
    } catch (error) {
      if (isTransientFsError(error)) {
        record(lifecycle, "supervisor_transient_fs_error", {
          code: error.code,
          message: error.message,
        });
      } else {
        record(lifecycle, "supervisor_fatal_error", {
          name: error?.name,
          code: error?.code || null,
          message: error?.message || String(error),
        });
        throw error;
      }
    }
    await delay(15_000);
  }
}

await main();
