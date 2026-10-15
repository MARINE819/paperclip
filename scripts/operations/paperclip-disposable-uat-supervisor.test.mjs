import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recoveryAction } from "./recovery-policy.mjs";
import {
  validateDisposableGuardrails,
  writeMarkerFile,
  readMarkerFile,
  removeMarkerIfMatches,
  isPidAlive,
  spawnDisposableChild,
  createCleanupHandler,
} from "./paperclip-disposable-uat-supervisor.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./paperclip-disposable-uat-supervisor.mjs", import.meta.url));

const cleanups = [];
function registerCleanup(fn) {
  cleanups.push(fn);
}
function runCleanups() {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      fn();
    } catch {
      /* best-effort */
    }
  }
}

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-disposable-uat-sup-test-"));
  registerCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function validOptsIn(tempDir) {
  const instanceRoot = path.join(tempDir, "instances", "f03-uat-disposable");
  return {
    instanceId: "f03-uat-disposable",
    homeDir: tempDir,
    instanceRoot,
    configPath: path.join(instanceRoot, "config.json"),
    apiPort: 39100,
    dbPort: 39300,
    embeddedPostgresDataDir: path.join(instanceRoot, "db"),
    restoreExecutionEnabled: "true",
  };
}

function fakeEnvWithUserProfile(userProfile) {
  return { USERPROFILE: userProfile };
}

test("rejects instanceId === 'default'", () => {
  const tempDir = createTempDir();
  try {
    const opts = validOptsIn(tempDir);
    opts.instanceId = "default";
    const result = validateDisposableGuardrails(opts, fakeEnvWithUserProfile(tempDir));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "instance_id_is_operating_default");
  } finally {
    runCleanups();
  }
});

test("rejects API port 3100", () => {
  const tempDir = createTempDir();
  try {
    const opts = validOptsIn(tempDir);
    opts.apiPort = 3100;
    const result = validateDisposableGuardrails(opts, fakeEnvWithUserProfile(tempDir));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "api_port_is_operating_port");
  } finally {
    runCleanups();
  }
});

test("rejects DB port 54329", () => {
  const tempDir = createTempDir();
  try {
    const opts = validOptsIn(tempDir);
    opts.dbPort = 54329;
    const result = validateDisposableGuardrails(opts, fakeEnvWithUserProfile(tempDir));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "db_port_is_operating_port");
  } finally {
    runCleanups();
  }
});

test("rejects an instance root equal to the operating default root", () => {
  const tempDir = createTempDir();
  try {
    const operatingRoot = path.join(tempDir, ".paperclip", "instances", "default");
    const opts = validOptsIn(tempDir);
    opts.instanceRoot = operatingRoot;
    opts.embeddedPostgresDataDir = path.join(operatingRoot, "db");
    const result = validateDisposableGuardrails(opts, fakeEnvWithUserProfile(tempDir));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "instance_root_overlaps_operating_default_root");
  } finally {
    runCleanups();
  }
});

test("rejects an instance root nested under the operating default root", () => {
  const tempDir = createTempDir();
  try {
    const operatingRoot = path.join(tempDir, ".paperclip", "instances", "default");
    const opts = validOptsIn(tempDir);
    opts.instanceRoot = path.join(operatingRoot, "nested", "disposable");
    opts.embeddedPostgresDataDir = path.join(opts.instanceRoot, "db");
    const result = validateDisposableGuardrails(opts, fakeEnvWithUserProfile(tempDir));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "instance_root_overlaps_operating_default_root");
  } finally {
    runCleanups();
  }
});

test("rejects a relative instanceRoot/homeDir/configPath/embeddedPostgresDataDir", () => {
  const tempDir = createTempDir();
  try {
    const base = validOptsIn(tempDir);

    const relativeInstanceRoot = { ...base, instanceRoot: "relative/instances/f03-uat-disposable" };
    assert.equal(
      validateDisposableGuardrails(relativeInstanceRoot, fakeEnvWithUserProfile(tempDir)).ok,
      false,
    );

    const relativeHome = { ...base, homeDir: "relative-home" };
    assert.equal(validateDisposableGuardrails(relativeHome, fakeEnvWithUserProfile(tempDir)).ok, false);

    const relativeConfig = { ...base, configPath: "relative-config.json" };
    assert.equal(validateDisposableGuardrails(relativeConfig, fakeEnvWithUserProfile(tempDir)).ok, false);

    const missingDataDir = { ...base, embeddedPostgresDataDir: undefined };
    assert.equal(validateDisposableGuardrails(missingDataDir, fakeEnvWithUserProfile(tempDir)).ok, false);
  } finally {
    runCleanups();
  }
});

test("rejects api port === db port", () => {
  const tempDir = createTempDir();
  try {
    const opts = validOptsIn(tempDir);
    opts.dbPort = opts.apiPort;
    const result = validateDisposableGuardrails(opts, fakeEnvWithUserProfile(tempDir));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "api_port_equals_db_port");
  } finally {
    runCleanups();
  }
});

test("rejects a non-integer or out-of-range port", () => {
  const tempDir = createTempDir();
  try {
    const base = validOptsIn(tempDir);

    const nonInteger = { ...base, apiPort: 39100.5 };
    assert.equal(validateDisposableGuardrails(nonInteger, fakeEnvWithUserProfile(tempDir)).ok, false);

    const tooHigh = { ...base, dbPort: 70000 };
    assert.equal(validateDisposableGuardrails(tooHigh, fakeEnvWithUserProfile(tempDir)).ok, false);

    const zero = { ...base, apiPort: 0 };
    assert.equal(validateDisposableGuardrails(zero, fakeEnvWithUserProfile(tempDir)).ok, false);
  } finally {
    runCleanups();
  }
});

test("rejects embeddedPostgresDataDir outside the disposable instance root", () => {
  const tempDir = createTempDir();
  try {
    const opts = validOptsIn(tempDir);
    opts.embeddedPostgresDataDir = path.join(tempDir, "somewhere-else", "db");
    const result = validateDisposableGuardrails(opts, fakeEnvWithUserProfile(tempDir));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "embedded_postgres_data_dir_outside_instance_root");
  } finally {
    runCleanups();
  }
});

test("rejects restoreExecutionEnabled that is not exactly the string 'true'", () => {
  const tempDir = createTempDir();
  try {
    const base = validOptsIn(tempDir);

    for (const badValue of [undefined, "TRUE", "1", true, "yes", ""]) {
      const opts = { ...base, restoreExecutionEnabled: badValue };
      const result = validateDisposableGuardrails(opts, fakeEnvWithUserProfile(tempDir));
      assert.equal(result.ok, false, `expected rejection for restoreExecutionEnabled=${JSON.stringify(badValue)}`);
      assert.equal(result.reason, "restore_execution_not_enabled");
    }
  } finally {
    runCleanups();
  }
});

test("accepts a fully valid disposable configuration", () => {
  const tempDir = createTempDir();
  try {
    const opts = validOptsIn(tempDir);
    const result = validateDisposableGuardrails(opts, fakeEnvWithUserProfile(tempDir));
    assert.deepEqual(result, { ok: true });
  } finally {
    runCleanups();
  }
});

test("source never sets shell:true on the spawn() call", () => {
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  assert.doesNotMatch(source, /shell\s*:\s*true/);
});

test("spawning a fixture child records the real supervisor pid and the real child pid", async () => {
  const tempDir = createTempDir();
  try {
    const markerRuntimePath = path.join(tempDir, "logs", "control-plane-runtime.pid");
    const markerSupervisorPath = path.join(tempDir, "logs", "control-plane-supervisor.pid");

    const child = spawnDisposableChild({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tempDir,
      env: { PATH: process.env.PATH },
      markerRuntimePath,
      markerSupervisorPath,
      supervisorPid: process.pid,
    });
    registerCleanup(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    });

    assert.equal(readMarkerFile(markerRuntimePath), child.pid);
    assert.equal(readMarkerFile(markerSupervisorPath), process.pid);
    assert.ok(isPidAlive(child.pid));

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  } finally {
    runCleanups();
  }
});

test("after the fixture child exits, recovery-policy's real recoveryAction recommends 'start', and respawning records a different pid", async () => {
  const tempDir = createTempDir();
  try {
    const markerRuntimePath = path.join(tempDir, "logs", "control-plane-runtime.pid");
    const markerSupervisorPath = path.join(tempDir, "logs", "control-plane-supervisor.pid");

    const firstChild = spawnDisposableChild({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: tempDir,
      env: { PATH: process.env.PATH },
      markerRuntimePath,
      markerSupervisorPath,
      supervisorPid: process.pid,
    });
    const firstPid = firstChild.pid;
    await new Promise((resolve) => firstChild.once("exit", resolve));

    const action = recoveryAction({
      apiReady: false,
      dbReady: false,
      runtimeAlive: isPidAlive(firstPid),
      appPortOpen: false,
      dbPortOpen: false,
      attempts: 0,
      now: Date.now(),
      nextAttemptAt: 0,
    });
    assert.equal(action, "start");

    const secondChild = spawnDisposableChild({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tempDir,
      env: { PATH: process.env.PATH },
      markerRuntimePath,
      markerSupervisorPath,
      supervisorPid: process.pid,
    });
    registerCleanup(() => {
      try {
        secondChild.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    });

    assert.notEqual(secondChild.pid, firstPid);
    assert.equal(readMarkerFile(markerRuntimePath), secondChild.pid);

    secondChild.kill("SIGKILL");
    await new Promise((resolve) => secondChild.once("exit", resolve));
  } finally {
    runCleanups();
  }
});

test("cleanup handler terminates only the tracked child and removes only its own matching markers", async () => {
  const tempDir = createTempDir();
  try {
    const markerRuntimePath = path.join(tempDir, "logs", "control-plane-runtime.pid");
    const markerSupervisorPath = path.join(tempDir, "logs", "control-plane-supervisor.pid");

    const child = spawnDisposableChild({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tempDir,
      env: { PATH: process.env.PATH },
      markerRuntimePath,
      markerSupervisorPath,
      supervisorPid: process.pid,
    });

    const cleanup = createCleanupHandler({
      getChild: () => child,
      markerRuntimePath,
      markerSupervisorPath,
      supervisorPid: process.pid,
    });

    const exited = new Promise((resolve) => child.once("exit", resolve));
    cleanup();
    await exited;

    assert.equal(isPidAlive(child.pid), false);
    assert.equal(fs.existsSync(markerRuntimePath), false);
    assert.equal(fs.existsSync(markerSupervisorPath), false);
  } finally {
    runCleanups();
  }
});

test("removeMarkerIfMatches never removes a marker recording a different pid", () => {
  const tempDir = createTempDir();
  try {
    const markerPath = path.join(tempDir, "logs", "control-plane-runtime.pid");
    writeMarkerFile(markerPath, 999999);

    const removed = removeMarkerIfMatches(markerPath, 123456);

    assert.equal(removed, false);
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(readMarkerFile(markerPath), 999999);
  } finally {
    runCleanups();
  }
});
