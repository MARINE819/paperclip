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
  parseNetstatPortOwnerPid,
  parseWin32ProcessInfo,
  isVerifiedDescendant,
  verifyAndRecordRealRuntimePid,
  confirmDisposableTeardown,
  handleRuntimePidVerificationFailure,
  runSupervisorTick,
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

// --- Verified runtime pid resolution -------------------------------------

test("parseNetstatPortOwnerPid finds the LISTENING pid for the exact local address and ignores other states/ports", () => {
  const stdout = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:39100        0.0.0.0:0              TIME_WAIT       111",
    "  TCP    127.0.0.1:39999        0.0.0.0:0              LISTENING       222",
    "  TCP    127.0.0.1:39100        0.0.0.0:0              LISTENING       12800",
  ].join("\r\n");
  assert.equal(parseNetstatPortOwnerPid(stdout, 39100), 12800);
});

test("parseNetstatPortOwnerPid returns null when no LISTENING line matches the port", () => {
  const stdout = "  TCP    127.0.0.1:39100        0.0.0.0:0              TIME_WAIT       111";
  assert.equal(parseNetstatPortOwnerPid(stdout, 39100), null);
  assert.equal(parseNetstatPortOwnerPid("", 39100), null);
});

test("parseWin32ProcessInfo parses 'parentPid|creationDate' and rejects malformed input", () => {
  const parsed = parseWin32ProcessInfo("33016|2026-10-16T01:50:10.0000000+09:00");
  assert.equal(parsed.parentPid, 33016);
  assert.equal(Number.isNaN(parsed.creationEpochMs), false);

  assert.equal(parseWin32ProcessInfo(""), null);
  assert.equal(parseWin32ProcessInfo("not-a-valid-line"), null);
  assert.equal(parseWin32ProcessInfo("0|2026-10-16T01:50:10.0000000+09:00"), null);
  assert.equal(parseWin32ProcessInfo("33016|not-a-date"), null);
});

test("isVerifiedDescendant walks the parent chain to find the bootstrap pid, bounded by maxHops", async () => {
  // Fake tree: 100 (bootstrap) -> 200 -> 300 (candidate)
  const tree = { 300: 200, 200: 100 };
  const getProcessInfoFn = async (pid) => {
    const parentPid = tree[pid];
    if (!parentPid) return null;
    return { parentPid, creationEpochMs: Date.now() };
  };

  assert.equal(await isVerifiedDescendant({ candidatePid: 100, bootstrapPid: 100, getProcessInfoFn }), true);
  assert.equal(await isVerifiedDescendant({ candidatePid: 300, bootstrapPid: 100, getProcessInfoFn }), true);
  assert.equal(await isVerifiedDescendant({ candidatePid: 300, bootstrapPid: 999, getProcessInfoFn }), false);
  assert.equal(
    await isVerifiedDescendant({ candidatePid: 300, bootstrapPid: 100, getProcessInfoFn, maxHops: 1 }),
    false,
  );
});

test("verifyAndRecordRealRuntimePid records the verified descendant pid when identity checks pass", async () => {
  const tempDir = createTempDir();
  try {
    const markerRuntimePath = path.join(tempDir, "logs", "control-plane-runtime.pid");
    const bootstrapSpawnedAtMs = Date.now() - 10_000;

    const result = await verifyAndRecordRealRuntimePid({
      apiPort: 39100,
      bootstrapPid: 100,
      bootstrapSpawnedAtMs,
      markerRuntimePath,
      getPortOwnerPidFn: async () => 300,
      getProcessInfoFn: async (pid) => {
        if (pid === 300) return { parentPid: 200, creationEpochMs: Date.now() };
        if (pid === 200) return { parentPid: 100, creationEpochMs: Date.now() };
        return null;
      },
    });

    assert.deepEqual(result, { ok: true, pid: 300 });
    assert.equal(readMarkerFile(markerRuntimePath), 300);
  } finally {
    runCleanups();
  }
});

test("verifyAndRecordRealRuntimePid refuses and does not write a marker when the port owner is not a descendant", async () => {
  const tempDir = createTempDir();
  try {
    const markerRuntimePath = path.join(tempDir, "logs", "control-plane-runtime.pid");
    writeMarkerFile(markerRuntimePath, 999); // pre-existing bootstrap-pid marker

    const result = await verifyAndRecordRealRuntimePid({
      apiPort: 39100,
      bootstrapPid: 999,
      bootstrapSpawnedAtMs: Date.now(),
      markerRuntimePath,
      getPortOwnerPidFn: async () => 555, // unrelated pid, not a descendant
      getProcessInfoFn: async () => ({ parentPid: 1, creationEpochMs: Date.now() }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "port_owner_not_descendant_of_bootstrap");
    assert.equal(readMarkerFile(markerRuntimePath), 999); // untouched
  } finally {
    runCleanups();
  }
});

test("verifyAndRecordRealRuntimePid refuses when no process owns the port", async () => {
  const tempDir = createTempDir();
  try {
    const markerRuntimePath = path.join(tempDir, "logs", "control-plane-runtime.pid");

    const result = await verifyAndRecordRealRuntimePid({
      apiPort: 39100,
      bootstrapPid: 999,
      bootstrapSpawnedAtMs: Date.now(),
      markerRuntimePath,
      getPortOwnerPidFn: async () => null,
      getProcessInfoFn: async () => null,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "port_owner_not_found");
    assert.equal(fs.existsSync(markerRuntimePath), false);
  } finally {
    runCleanups();
  }
});

test("verifyAndRecordRealRuntimePid refuses a pid-reused process whose creation time predates this spawn", () => {
  return (async () => {
    const tempDir = createTempDir();
    try {
      const markerRuntimePath = path.join(tempDir, "logs", "control-plane-runtime.pid");
      const bootstrapSpawnedAtMs = Date.now();

      const result = await verifyAndRecordRealRuntimePid({
        apiPort: 39100,
        bootstrapPid: 300, // direct hit, no ancestry walk needed
        bootstrapSpawnedAtMs,
        markerRuntimePath,
        getPortOwnerPidFn: async () => 300,
        getProcessInfoFn: async () => ({ parentPid: 1, creationEpochMs: bootstrapSpawnedAtMs - 60_000 }),
      });

      assert.equal(result.ok, false);
      assert.equal(result.reason, "candidate_predates_bootstrap_spawn");
      assert.equal(fs.existsSync(markerRuntimePath), false);
    } finally {
      runCleanups();
    }
  })();
});

test("confirmDisposableTeardown resolves ok:true once the child is dead and both ports are free", async () => {
  const tempDir = createTempDir();
  try {
    const child = spawnDisposableChild({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tempDir,
      env: { PATH: process.env.PATH },
      markerRuntimePath: path.join(tempDir, "logs", "control-plane-runtime.pid"),
      markerSupervisorPath: path.join(tempDir, "logs", "control-plane-supervisor.pid"),
      supervisorPid: process.pid,
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;

    const result = await confirmDisposableTeardown({
      childPid: child.pid,
      apiPort: 48123,
      dbPort: 48124,
      maxAttempts: 3,
      intervalMs: 20,
    });

    assert.equal(result.ok, true);
  } finally {
    runCleanups();
  }
});

test("confirmDisposableTeardown reports ok:false (never escalates to another pid/port) when the tracked child never exits in time", async () => {
  const tempDir = createTempDir();
  try {
    const child = spawnDisposableChild({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tempDir,
      env: { PATH: process.env.PATH },
      markerRuntimePath: path.join(tempDir, "logs", "control-plane-runtime.pid"),
      markerSupervisorPath: path.join(tempDir, "logs", "control-plane-supervisor.pid"),
      supervisorPid: process.pid,
    });
    registerCleanup(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    });

    const result = await confirmDisposableTeardown({
      childPid: child.pid,
      apiPort: 48125,
      dbPort: 48126,
      maxAttempts: 2,
      intervalMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.equal(result.childAlive, true);
  } finally {
    runCleanups();
  }
});

test("handleRuntimePidVerificationFailure tears the tracked child down via the real cleanup handler and confirms teardown", async () => {
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

    const result = await handleRuntimePidVerificationFailure({
      reason: "port_owner_not_descendant_of_bootstrap",
      instanceId: "f03-uat-disposable",
      childPid: child.pid,
      apiPort: 48127,
      dbPort: 48128,
      cleanupFn: cleanup,
      maxAttempts: 10,
      intervalMs: 20,
    });

    assert.equal(result.ok, true);
    assert.equal(isPidAlive(child.pid), false);
    assert.equal(fs.existsSync(markerRuntimePath), false);
    assert.equal(fs.existsSync(markerSupervisorPath), false);
  } finally {
    runCleanups();
  }
});

test("handleRuntimePidVerificationFailure reports an unconfirmed teardown honestly instead of touching any other pid/port", async () => {
  const tempDir = createTempDir();
  try {
    const child = spawnDisposableChild({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tempDir,
      env: { PATH: process.env.PATH },
      markerRuntimePath: path.join(tempDir, "logs", "control-plane-runtime.pid"),
      markerSupervisorPath: path.join(tempDir, "logs", "control-plane-supervisor.pid"),
      supervisorPid: process.pid,
    });
    registerCleanup(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    });

    let noopCleanupCalls = 0;
    const noopCleanupFn = () => {
      noopCleanupCalls += 1;
      // Deliberately does not touch the child -- simulates cleanup failing
      // to actually terminate it, which must be reported, never papered
      // over by widening the search to some other pid or port.
    };

    const result = await handleRuntimePidVerificationFailure({
      reason: "candidate_predates_bootstrap_spawn",
      instanceId: "f03-uat-disposable",
      childPid: child.pid,
      apiPort: 48129,
      dbPort: 48130,
      cleanupFn: noopCleanupFn,
      maxAttempts: 2,
      intervalMs: 20,
    });

    assert.equal(noopCleanupCalls, 1);
    assert.equal(result.ok, false);
    assert.equal(isPidAlive(child.pid), true);
  } finally {
    runCleanups();
  }
});

test("runSupervisorTick catches a thrown error from spawnChildFn and reports tick-error instead of rejecting", async () => {
  const state = {
    child: { pid: 999999 },
    bootstrapSpawnedAtMs: Date.now(),
    verifiedRuntimePid: "already-verified",
    attempts: 0,
    nextAttemptAt: 0,
  };
  const deps = {
    instanceId: "f03-uat-disposable",
    apiPort: 39100,
    dbPort: 39300,
    markerRuntimePath: path.join(os.tmpdir(), "does-not-matter.pid"),
    spawnChildFn: () => {
      throw new Error("synthetic spawn failure");
    },
    apiReadyFn: async () => false,
    dbReadyFn: async () => false,
    portOpenFn: async () => false,
    isPidAliveFn: () => false,
    recoveryActionFn: () => "start",
    verifyRuntimePidFn: async () => ({ ok: true, pid: 1 }),
    handleVerificationFailureFn: async () => ({ ok: true }),
    getPortOwnerPidFn: async () => null,
    getProcessInfoFn: async () => null,
    cleanupFn: () => {},
  };

  const result = await runSupervisorTick(state, deps);

  assert.equal(result.outcome, "tick-error");
  assert.ok(result.error instanceof Error);
});

test("runSupervisorTick logs manual-attention and does not attempt a restart", async () => {
  let spawnCalls = 0;
  const state = {
    child: { pid: 999999 },
    bootstrapSpawnedAtMs: Date.now(),
    verifiedRuntimePid: "already-verified",
    attempts: 0,
    nextAttemptAt: 0,
  };
  const deps = {
    instanceId: "f03-uat-disposable",
    apiPort: 39100,
    dbPort: 39300,
    markerRuntimePath: path.join(os.tmpdir(), "does-not-matter.pid"),
    spawnChildFn: () => {
      spawnCalls += 1;
      return { pid: 123 };
    },
    apiReadyFn: async () => false,
    dbReadyFn: async () => false,
    portOpenFn: async () => false,
    isPidAliveFn: () => true,
    recoveryActionFn: () => "manual-attention",
    verifyRuntimePidFn: async () => ({ ok: true, pid: 1 }),
    handleVerificationFailureFn: async () => ({ ok: true }),
    getPortOwnerPidFn: async () => null,
    getProcessInfoFn: async () => null,
    cleanupFn: () => {},
  };

  const result = await runSupervisorTick(state, deps);

  assert.equal(result.outcome, "manual-attention");
  assert.equal(spawnCalls, 0);
});

test("spawnDisposableChild attaches an error listener so a synthetic 'error' event never crashes the process", () => {
  const tempDir = createTempDir();
  try {
    const child = spawnDisposableChild({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tempDir,
      env: { PATH: process.env.PATH },
      markerRuntimePath: path.join(tempDir, "logs", "control-plane-runtime.pid"),
      markerSupervisorPath: path.join(tempDir, "logs", "control-plane-supervisor.pid"),
      supervisorPid: process.pid,
      instanceId: "f03-uat-disposable",
    });
    registerCleanup(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    });

    assert.doesNotThrow(() => {
      child.emit("error", new Error("synthetic spawn-level error"));
    });
  } finally {
    runCleanups();
  }
});

test("runSupervisorTick ignores a concurrent re-entrant call while one is already in-flight", async () => {
  const state = {
    child: { pid: 1 },
    bootstrapSpawnedAtMs: Date.now(),
    verifiedRuntimePid: "already-verified",
    attempts: 0,
    nextAttemptAt: 0,
  };
  let resolveApiReady;
  const deps = {
    instanceId: "f03-uat-disposable",
    apiPort: 39100,
    dbPort: 39300,
    markerRuntimePath: path.join(os.tmpdir(), "does-not-matter.pid"),
    spawnChildFn: () => ({ pid: 2 }),
    apiReadyFn: () => new Promise((resolve) => { resolveApiReady = resolve; }),
    dbReadyFn: async () => false,
    portOpenFn: async () => false,
    isPidAliveFn: () => true,
    recoveryActionFn: () => "cooldown",
    verifyRuntimePidFn: async () => ({ ok: true, pid: 1 }),
    handleVerificationFailureFn: async () => ({ ok: true }),
    getPortOwnerPidFn: async () => null,
    getProcessInfoFn: async () => null,
    cleanupFn: () => {},
  };

  const firstCallPromise = runSupervisorTick(state, deps);
  assert.equal(state.tickInProgress, true);

  const secondResult = await runSupervisorTick(state, deps);
  assert.deepEqual(secondResult, { outcome: "skipped-reentrant" });

  resolveApiReady(false);
  const firstResult = await firstCallPromise;
  assert.notEqual(firstResult.outcome, "skipped-reentrant");
  assert.equal(state.tickInProgress, false);
});

test("runSupervisorTick releases the reentrancy guard after a thrown error", async () => {
  const state = {
    child: { pid: 1 },
    bootstrapSpawnedAtMs: Date.now(),
    verifiedRuntimePid: "already-verified",
    attempts: 0,
    nextAttemptAt: 0,
  };
  const throwingDeps = {
    instanceId: "f03-uat-disposable",
    apiPort: 39100,
    dbPort: 39300,
    markerRuntimePath: path.join(os.tmpdir(), "does-not-matter.pid"),
    spawnChildFn: () => {
      throw new Error("synthetic spawn failure");
    },
    apiReadyFn: async () => false,
    dbReadyFn: async () => false,
    portOpenFn: async () => false,
    isPidAliveFn: () => false,
    recoveryActionFn: () => "start",
    verifyRuntimePidFn: async () => ({ ok: true, pid: 1 }),
    handleVerificationFailureFn: async () => ({ ok: true }),
    getPortOwnerPidFn: async () => null,
    getProcessInfoFn: async () => null,
    cleanupFn: () => {},
  };

  const firstResult = await runSupervisorTick(state, throwingDeps);
  assert.equal(firstResult.outcome, "tick-error");
  assert.equal(state.tickInProgress, false);

  const okDeps = { ...throwingDeps, spawnChildFn: () => ({ pid: 2 }), recoveryActionFn: () => "cooldown" };
  const secondResult = await runSupervisorTick(state, okDeps);
  assert.notEqual(secondResult.outcome, "skipped-reentrant");
});

test("runSupervisorTick holds the guard through the full verification-failure teardown wait, then releases it", async () => {
  const state = {
    child: { pid: 1 },
    bootstrapSpawnedAtMs: Date.now(),
    verifiedRuntimePid: null,
    attempts: 0,
    nextAttemptAt: 0,
  };
  let guardHeldDuringTeardown = false;
  const deps = {
    instanceId: "f03-uat-disposable",
    apiPort: 39100,
    dbPort: 39300,
    markerRuntimePath: path.join(os.tmpdir(), "does-not-matter.pid"),
    spawnChildFn: () => ({ pid: 2 }),
    apiReadyFn: async () => true,
    dbReadyFn: async () => true,
    portOpenFn: async () => false,
    isPidAliveFn: () => true,
    recoveryActionFn: () => "cooldown",
    verifyRuntimePidFn: async () => ({ ok: false, reason: "port_owner_not_found" }),
    handleVerificationFailureFn: async () => {
      guardHeldDuringTeardown = state.tickInProgress === true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ok: true };
    },
    getPortOwnerPidFn: async () => null,
    getProcessInfoFn: async () => null,
    cleanupFn: () => {},
  };

  const result = await runSupervisorTick(state, deps);

  assert.equal(result.outcome, "verification-failed");
  assert.equal(guardHeldDuringTeardown, true);
  assert.equal(state.tickInProgress, false);

  const next = await runSupervisorTick(state, { ...deps, verifyRuntimePidFn: async () => ({ ok: true, pid: 99 }) });
  assert.notEqual(next.outcome, "skipped-reentrant");
});
