import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeRestartControlRequest,
  resolveRestartControlRequestPath,
  writeSelfTargetedRestartControlRequest,
  type RestartControlRequest,
} from "./restart-control.js";
import { getServerInfoSnapshot } from "../server-info.js";

const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
});

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-restart-control-"));
  try {
    return await fn(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

const CURRENT_PID = 11548;
const OTHER_PID = 22222;
const CURRENT_STARTED_AT = "2026-09-22T16:41:15.899Z";

function baseRequest(overrides: Partial<RestartControlRequest> = {}): RestartControlRequest {
  return {
    version: 1,
    requestId: "req-1",
    createdAt: "2026-09-23T02:00:00.000Z",
    requestedBy: "ceo-approved-operator",
    reason: "stage8_web_push_deploy",
    targetProcessStartedAt: CURRENT_STARTED_AT,
    targetPid: CURRENT_PID,
    ...overrides,
  };
}

async function writeRequestFile(homeDir: string, targetPid: number, request: unknown) {
  const requestPath = resolveRestartControlRequestPath(targetPid, homeDir);
  await fs.mkdir(path.dirname(requestPath), { recursive: true });
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return requestPath;
}

describe("consumeRestartControlRequest", () => {
  it("returns none when no request file exists", async () => {
    await withTempHome(async (homeDir) => {
      await expect(
        consumeRestartControlRequest({
          currentPid: CURRENT_PID,
          currentProcessStartedAt: CURRENT_STARTED_AT,
          homeDir,
        }),
      ).resolves.toEqual({ action: "none" });
    });
  });

  it("accepts a fresh, matching request and consumes the file", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest();
      const requestPath = await writeRequestFile(homeDir, CURRENT_PID, request);

      const decision = await consumeRestartControlRequest({
        currentPid: CURRENT_PID,
        currentProcessStartedAt: CURRENT_STARTED_AT,
        now: new Date("2026-09-23T02:00:10.000Z"),
        homeDir,
      });

      expect(decision).toEqual({ action: "shutdown", request });
      await expect(fs.access(requestPath)).rejects.toThrow();
    });
  });

  it("matches on targetPid when targetProcessStartedAt is not provided", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest({ targetProcessStartedAt: null, targetPid: CURRENT_PID });
      await writeRequestFile(homeDir, CURRENT_PID, request);

      const decision = await consumeRestartControlRequest({
        currentPid: CURRENT_PID,
        currentProcessStartedAt: CURRENT_STARTED_AT,
        now: new Date("2026-09-23T02:00:10.000Z"),
        homeDir,
      });

      expect(decision).toEqual({ action: "shutdown", request });
    });
  });

  it("ignores a request whose TTL has expired (stale)", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest({ createdAt: "2026-09-23T01:00:00.000Z" });
      await writeRequestFile(homeDir, CURRENT_PID, request);

      const decision = await consumeRestartControlRequest({
        currentPid: CURRENT_PID,
        currentProcessStartedAt: CURRENT_STARTED_AT,
        now: new Date("2026-09-23T01:06:00.000Z"), // 6 minutes later, TTL is 5 minutes
        ttlMs: 5 * 60 * 1000,
        homeDir,
      });

      expect(decision).toEqual({ action: "ignored", reason: "stale", request });
    });
  });

  it("ignores a request dated far in the future as stale (clock skew)", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest({ createdAt: "2026-09-23T02:10:00.000Z" });
      await writeRequestFile(homeDir, CURRENT_PID, request);

      const decision = await consumeRestartControlRequest({
        currentPid: CURRENT_PID,
        currentProcessStartedAt: CURRENT_STARTED_AT,
        now: new Date("2026-09-23T02:00:00.000Z"),
        homeDir,
      });

      expect(decision).toEqual({ action: "ignored", reason: "stale", request });
    });
  });

  it("ignores a request whose target identity does not match the current process", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest({ targetProcessStartedAt: "2020-01-01T00:00:00.000Z" });
      await writeRequestFile(homeDir, CURRENT_PID, request);

      const decision = await consumeRestartControlRequest({
        currentPid: CURRENT_PID,
        currentProcessStartedAt: CURRENT_STARTED_AT,
        now: new Date("2026-09-23T02:00:10.000Z"),
        homeDir,
      });

      expect(decision).toEqual({ action: "ignored", reason: "target_mismatch", request });
    });
  });

  it("ignores malformed JSON without throwing", async () => {
    await withTempHome(async (homeDir) => {
      const requestPath = resolveRestartControlRequestPath(CURRENT_PID, homeDir);
      await fs.mkdir(path.dirname(requestPath), { recursive: true });
      await fs.writeFile(requestPath, "{ not json", "utf8");

      const decision = await consumeRestartControlRequest({
        currentPid: CURRENT_PID,
        currentProcessStartedAt: CURRENT_STARTED_AT,
        homeDir,
      });

      expect(decision).toEqual({ action: "ignored", reason: "malformed_json", request: null });
    });
  });

  it("ignores a request missing both targetPid and targetProcessStartedAt", async () => {
    await withTempHome(async (homeDir) => {
      await writeRequestFile(homeDir, CURRENT_PID, {
        version: 1,
        requestId: "req-2",
        createdAt: new Date().toISOString(),
        requestedBy: "operator",
        reason: "no target",
      });

      const decision = await consumeRestartControlRequest({
        currentPid: CURRENT_PID,
        currentProcessStartedAt: CURRENT_STARTED_AT,
        homeDir,
      });

      expect(decision).toEqual({ action: "ignored", reason: "malformed_shape", request: null });
    });
  });

  it("duplicate/replay guard: a second consume call after acceptance sees no file", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest();
      await writeRequestFile(homeDir, CURRENT_PID, request);

      const first = await consumeRestartControlRequest({
        currentPid: CURRENT_PID,
        currentProcessStartedAt: CURRENT_STARTED_AT,
        now: new Date("2026-09-23T02:00:10.000Z"),
        homeDir,
      });
      expect(first.action).toBe("shutdown");

      // Simulates the watcher's next poll tick, or a fresh process after
      // restart re-reading the same well-known path: the file is gone, so
      // the same requestId can never be honored twice.
      const second = await consumeRestartControlRequest({
        currentPid: CURRENT_PID,
        currentProcessStartedAt: CURRENT_STARTED_AT,
        now: new Date("2026-09-23T02:00:20.000Z"),
        homeDir,
      });
      expect(second).toEqual({ action: "none" });
    });
  });

  it("does not reprocess a stale request left over from before a restart, even if the new process reuses the same PID", async () => {
    await withTempHome(async (homeDir) => {
      // An old request that never got picked up before TTL expired should not
      // resurrect itself and restart a brand-new process it never targeted,
      // even in the worst case where Windows has already reused the PID.
      const request = baseRequest({ createdAt: "2026-09-23T01:00:00.000Z" });
      await writeRequestFile(homeDir, CURRENT_PID, request);

      const decision = await consumeRestartControlRequest({
        currentPid: CURRENT_PID, // PID reused by an unrelated new process
        currentProcessStartedAt: "2026-09-23T02:05:00.000Z", // different boot identity
        now: new Date("2026-09-23T02:06:00.000Z"),
        ttlMs: 5 * 60 * 1000,
        homeDir,
      });

      expect(decision.action).toBe("ignored");
    });
  });

  // --- Multi-process isolation (RESTART_CONTROL_MULTI_PROCESS_RACE fix) ---

  it("[A] a request scoped to one PID is invisible to a consumer with a different PID, and is left untouched", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest({ targetPid: CURRENT_PID });
      const requestPath = await writeRequestFile(homeDir, CURRENT_PID, request);

      const decision = await consumeRestartControlRequest({
        currentPid: OTHER_PID,
        currentProcessStartedAt: "2026-09-23T03:00:00.000Z",
        now: new Date("2026-09-23T02:00:10.000Z"),
        homeDir,
      });

      expect(decision).toEqual({ action: "none" });
      // Untouched: still present, and still exactly the bytes that were written.
      const stillThere = JSON.parse(await fs.readFile(requestPath, "utf8"));
      expect(stillThere).toEqual(request);
    });
  });

  it("[B] the matching PID's own consumer accepts and consumes its request", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest({ targetPid: CURRENT_PID });
      const requestPath = await writeRequestFile(homeDir, CURRENT_PID, request);

      const decision = await consumeRestartControlRequest({
        currentPid: CURRENT_PID,
        currentProcessStartedAt: CURRENT_STARTED_AT,
        now: new Date("2026-09-23T02:00:10.000Z"),
        homeDir,
      });

      expect(decision).toEqual({ action: "shutdown", request });
      await expect(fs.access(requestPath)).rejects.toThrow();
    });
  });

  it("[C] concurrent polling by two different PIDs never races: only the targeted PID acts", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest({ targetPid: CURRENT_PID });
      await writeRequestFile(homeDir, CURRENT_PID, request);

      const [ownerDecision, otherDecision] = await Promise.all([
        consumeRestartControlRequest({
          currentPid: CURRENT_PID,
          currentProcessStartedAt: CURRENT_STARTED_AT,
          now: new Date("2026-09-23T02:00:10.000Z"),
          homeDir,
        }),
        consumeRestartControlRequest({
          currentPid: OTHER_PID,
          currentProcessStartedAt: "2026-09-23T03:00:00.000Z",
          now: new Date("2026-09-23T02:00:10.000Z"),
          homeDir,
        }),
      ]);

      expect(ownerDecision).toEqual({ action: "shutdown", request });
      expect(otherDecision).toEqual({ action: "none" });
    });
  });

  it("[J] a PID-200 consume leaves a PID-100 request file byte-for-byte intact", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest({ targetPid: CURRENT_PID, reason: "unchanged-bytes-check" });
      const requestPath = await writeRequestFile(homeDir, CURRENT_PID, request);
      const before = await fs.readFile(requestPath, "utf8");

      await consumeRestartControlRequest({
        currentPid: OTHER_PID,
        currentProcessStartedAt: "2026-09-23T03:00:00.000Z",
        now: new Date("2026-09-23T02:00:10.000Z"),
        homeDir,
      });

      const after = await fs.readFile(requestPath, "utf8");
      expect(after).toBe(before);
    });
  });

  it("[H] same PID but a different targetProcessStartedAt refuses to shut down (PID reuse guard)", async () => {
    await withTempHome(async (homeDir) => {
      const request = baseRequest({
        targetPid: CURRENT_PID,
        targetProcessStartedAt: "2020-01-01T00:00:00.000Z", // an older, unrelated boot
      });
      await writeRequestFile(homeDir, CURRENT_PID, request);

      const decision = await consumeRestartControlRequest({
        currentPid: CURRENT_PID, // same PID, but this is a different (newer) process
        currentProcessStartedAt: CURRENT_STARTED_AT,
        now: new Date("2026-09-23T02:00:10.000Z"),
        homeDir,
      });

      expect(decision).toEqual({ action: "ignored", reason: "target_mismatch", request });
    });
  });
});

describe("writeSelfTargetedRestartControlRequest", () => {
  it("writes a fresh self-targeted request when none exists", async () => {
    await withTempHome(async (homeDir) => {
      const outcome = await writeSelfTargetedRestartControlRequest({
        reason: "test_reason",
        requestedBy: "test-actor",
        homeDir,
      });

      expect(outcome.outcome).toBe("published");
      if (outcome.outcome !== "published") throw new Error("unreachable");
      expect(outcome.request.targetPid).toBe(process.pid);
      expect(outcome.request.targetProcessStartedAt).toBe(getServerInfoSnapshot().processStartedAt);

      const requestPath = resolveRestartControlRequestPath(process.pid, homeDir);
      const onDisk = JSON.parse(await fs.readFile(requestPath, "utf8"));
      expect(onDisk).toEqual(outcome.request);
    });
  });

  it("is idempotent: a second call while a valid request is still pending returns the existing request without rewriting it", async () => {
    await withTempHome(async (homeDir) => {
      const first = await writeSelfTargetedRestartControlRequest({
        reason: "first_reason",
        requestedBy: "test-actor",
        homeDir,
      });
      const second = await writeSelfTargetedRestartControlRequest({
        reason: "second_reason",
        requestedBy: "different-actor",
        homeDir,
      });

      expect(second).toEqual(first);
    });
  });

  it("the written request is correctly consumable by the existing, unmodified restart-control watcher", async () => {
    await withTempHome(async (homeDir) => {
      const outcome = await writeSelfTargetedRestartControlRequest({
        reason: "test_reason",
        requestedBy: "test-actor",
        homeDir,
      });
      if (outcome.outcome !== "published") throw new Error("unreachable");

      const decision = await consumeRestartControlRequest({
        currentPid: process.pid,
        currentProcessStartedAt: getServerInfoSnapshot().processStartedAt,
        homeDir,
      });

      expect(decision).toEqual({ action: "shutdown", request: outcome.request });
    });
  });

  it("classifies a failed temp-file write as definite_no_publish (rename never attempted)", async () => {
    await withTempHome(async (homeDir) => {
      const outcome = await writeSelfTargetedRestartControlRequest({
        reason: "test_reason",
        requestedBy: "test-actor",
        homeDir,
        fsOverrides: {
          writeFile: async () => {
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          },
        },
      });

      expect(outcome.outcome).toBe("definite_no_publish");
    });
  });

  it("[test 5] classifies an ENOENT found after a rename failure as definite_no_publish, and restores no leftover file", async () => {
    await withTempHome(async (homeDir) => {
      const outcome = await writeSelfTargetedRestartControlRequest({
        reason: "test_reason",
        requestedBy: "test-actor",
        homeDir,
        fsOverrides: {
          rename: async () => {
            throw Object.assign(new Error("rename failed"), { code: "EPERM" });
          },
        },
      });

      expect(outcome.outcome).toBe("definite_no_publish");
      await expect(fs.access(resolveRestartControlRequestPath(process.pid, homeDir))).rejects.toThrow();
    });
  });

  it("[test 1] never treats EACCES/EPERM on the post-failure read as ENOENT", async () => {
    await withTempHome(async (homeDir) => {
      const outcome = await writeSelfTargetedRestartControlRequest({
        reason: "test_reason",
        requestedBy: "test-actor",
        homeDir,
        fsOverrides: {
          rename: async () => {
            throw new Error("rename failed");
          },
          readFile: (async () => {
            throw Object.assign(new Error("access denied"), { code: "EACCES" });
          }) as typeof fs.readFile,
        },
      });

      expect(outcome.outcome).toBe("ambiguous");
    });
  });

  it("[test 2] a different, pre-existing request at the same path is never treated as definite publish", async () => {
    await withTempHome(async (homeDir) => {
      const requestPath = resolveRestartControlRequestPath(process.pid, homeDir);
      await fs.mkdir(path.dirname(requestPath), { recursive: true });
      await fs.writeFile(
        requestPath,
        JSON.stringify(
          baseRequest({ requestId: "some-other-unrelated-request-id", targetPid: OTHER_PID }),
        ),
        "utf8",
      );

      const outcome = await writeSelfTargetedRestartControlRequest({
        reason: "test_reason",
        requestedBy: "test-actor",
        homeDir,
        requestId: "deterministic-test-request-id",
        fsOverrides: {
          rename: async () => {
            throw new Error("rename failed");
          },
        },
      });

      expect(outcome.outcome).toBe("ambiguous");
    });
  });

  it("[test 3] definite publish is recognized only when requestId, targetPid, and targetProcessStartedAt all match this call", async () => {
    await withTempHome(async (homeDir) => {
      const requestId = "deterministic-test-request-id-match";
      const requestPath = resolveRestartControlRequestPath(process.pid, homeDir);
      const matchingRequest: RestartControlRequest = {
        version: 1,
        requestId,
        createdAt: new Date().toISOString(),
        requestedBy: "someone-else",
        reason: "a different reason string",
        targetProcessStartedAt: getServerInfoSnapshot().processStartedAt,
        targetPid: process.pid,
      };
      await fs.mkdir(path.dirname(requestPath), { recursive: true });
      await fs.writeFile(requestPath, JSON.stringify(matchingRequest), "utf8");

      const outcome = await writeSelfTargetedRestartControlRequest({
        reason: "test_reason",
        requestedBy: "test-actor",
        homeDir,
        requestId,
        fsOverrides: {
          rename: async () => {
            throw new Error("rename failed");
          },
        },
      });

      expect(outcome).toEqual({ outcome: "published", request: matchingRequest });
    });
  });

  it("[test 4] malformed JSON found after a rename failure is treated as ambiguous", async () => {
    await withTempHome(async (homeDir) => {
      const requestPath = resolveRestartControlRequestPath(process.pid, homeDir);
      await fs.mkdir(path.dirname(requestPath), { recursive: true });
      await fs.writeFile(requestPath, "{ not json", "utf8");

      const outcome = await writeSelfTargetedRestartControlRequest({
        reason: "test_reason",
        requestedBy: "test-actor",
        homeDir,
        fsOverrides: {
          rename: async () => {
            throw new Error("rename failed");
          },
        },
      });

      expect(outcome.outcome).toBe("ambiguous");
    });
  });
});
