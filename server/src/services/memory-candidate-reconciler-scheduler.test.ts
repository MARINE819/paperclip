import { describe, expect, it, vi } from "vitest";
import { createMemoryCandidateReconcilerScheduler } from "./memory-candidate-reconciler-scheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A fake timer harness: `setIntervalFn`/`clearIntervalFn` never touch real
 * timers. The test drives ticks explicitly by calling `fireInterval()`, so
 * nothing in this file depends on wall-clock time or real sleeps.
 */
function fakeTimerHarness() {
  let handler: (() => void) | null = null;
  let cleared = false;
  const unref = vi.fn();
  const fakeHandle = { unref } as unknown as NodeJS.Timeout;
  return {
    setIntervalFn: vi.fn((h: () => void, _timeoutMs: number) => {
      handler = h;
      return fakeHandle;
    }),
    clearIntervalFn: vi.fn((_handle: NodeJS.Timeout) => {
      cleared = true;
    }),
    fireInterval: () => {
      if (!handler) throw new Error("interval handler was never registered");
      handler();
    },
    unref,
    wasCleared: () => cleared,
  };
}

function silentLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe("createMemoryCandidateReconcilerScheduler", () => {
  it("runs a startup-once tick immediately when started", async () => {
    const harness = fakeTimerHarness();
    const reconcile = vi.fn().mockResolvedValue({ created: 0 });
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile,
      intervalMs: 60_000,
      logger: silentLogger(),
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
  });

  it("registers the interval with the configured intervalMs and unrefs the handle", () => {
    const harness = fakeTimerHarness();
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile: vi.fn().mockResolvedValue({}),
      intervalMs: 45_000,
      logger: silentLogger(),
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();

    expect(harness.setIntervalFn).toHaveBeenCalledTimes(1);
    expect(harness.setIntervalFn.mock.calls[0]![1]).toBe(45_000);
    expect(harness.unref).toHaveBeenCalledTimes(1);
  });

  it("runs an additional tick each time the interval fires", async () => {
    const harness = fakeTimerHarness();
    const reconcile = vi.fn().mockResolvedValue({});
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile,
      intervalMs: 60_000,
      logger: silentLogger(),
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    // Wait for the startup tick's whole promise chain to settle (not just
    // the call itself) before firing the next tick — otherwise this test's
    // near-instantly-resolving mock can race the single-flight guard, which
    // a real, DB-bound reconcile() never would in production.
    await vi.waitFor(() => expect(scheduler.isTickInFlight()).toBe(false));

    harness.fireInterval();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(scheduler.isTickInFlight()).toBe(false));

    harness.fireInterval();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3));
  });

  it("does not start a second, overlapping tick while one is still in flight (single-flight)", async () => {
    const harness = fakeTimerHarness();
    const gate = deferred<Record<string, unknown>>();
    const reconcile = vi.fn().mockReturnValue(gate.promise);
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile,
      intervalMs: 60_000,
      logger: silentLogger(),
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start(); // kicks off the startup tick, which never resolves until we say so
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(scheduler.isTickInFlight()).toBe(true);

    // The interval fires twice while the first tick is still pending.
    harness.fireInterval();
    harness.fireInterval();
    // Give any (incorrect) extra async work a chance to start.
    await Promise.resolve();
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1); // still just the one in-flight call

    gate.resolve({});
    await vi.waitFor(() => expect(scheduler.isTickInFlight()).toBe(false));

    // Now that the first tick finished, a fresh interval firing starts a new one.
    harness.fireInterval();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
  });

  it("swallows a reconcile rejection without throwing and without stopping future ticks", async () => {
    const harness = fakeTimerHarness();
    const logger = silentLogger();
    let call = 0;
    const reconcile = vi.fn().mockImplementation(() => {
      call += 1;
      return call === 1 ? Promise.reject(new Error("boom")) : Promise.resolve({});
    });
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile,
      intervalMs: 60_000,
      logger,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(scheduler.isTickInFlight()).toBe(false));

    harness.fireInterval();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
  });

  it("start() is idempotent: calling it twice does not register a second interval", () => {
    const harness = fakeTimerHarness();
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile: vi.fn().mockResolvedValue({}),
      intervalMs: 60_000,
      logger: silentLogger(),
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();
    scheduler.start();
    expect(harness.setIntervalFn).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the interval and awaits any in-flight tick", async () => {
    const harness = fakeTimerHarness();
    const gate = deferred<Record<string, unknown>>();
    const reconcile = vi.fn().mockReturnValue(gate.promise);
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile,
      intervalMs: 60_000,
      logger: silentLogger(),
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stopPromise = scheduler.stop().then(() => {
      stopped = true;
    });
    expect(harness.clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(false); // stop() must wait for the in-flight tick

    gate.resolve({});
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it("stop() is safe to call when the scheduler was never started", async () => {
    const harness = fakeTimerHarness();
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile: vi.fn().mockResolvedValue({}),
      intervalMs: 60_000,
      logger: silentLogger(),
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    await expect(scheduler.stop()).resolves.toBeUndefined();
    expect(harness.clearIntervalFn).not.toHaveBeenCalled();
  });

  // --- Phase 3.0C-1: tick duration, in-flight skip logging, cooldown-map size ---

  /** A code-controlled clock — the scheduler only ever reads it via `now()`, never `Date.now()` directly. */
  function fakeClock(startAt = 0) {
    let current = startAt;
    return {
      now: () => current,
      advance: (ms: number) => {
        current += ms;
      },
      set: (t: number) => {
        current = t;
      },
    };
  }

  it("records the exact tick duration (injected clock) in the completion log, nested alongside the result", async () => {
    const harness = fakeTimerHarness();
    const clock = fakeClock(1_000);
    const gate = deferred<Record<string, unknown>>();
    const logger = silentLogger();
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile: vi.fn().mockReturnValue(gate.promise),
      intervalMs: 60_000,
      logger,
      now: clock.now,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();
    await vi.waitFor(() => expect(scheduler.isTickInFlight()).toBe(true));

    clock.advance(250);
    gate.resolve({ scanned: 3, created: 1 });
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(
      { result: { scanned: 3, created: 1 }, durationMs: 250 },
      "memory candidate reconciliation tick completed",
    ));
  });

  it("records the exact tick duration in the failure log when reconcile rejects, optionally alongside cooldownMapSize", async () => {
    const harness = fakeTimerHarness();
    const clock = fakeClock(5_000);
    const gate = deferred<Record<string, unknown>>();
    const logger = silentLogger();
    const boom = new Error("boom");
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile: vi.fn().mockReturnValue(gate.promise),
      intervalMs: 60_000,
      logger,
      now: clock.now,
      getCooldownMapSize: () => 7,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();
    await vi.waitFor(() => expect(scheduler.isTickInFlight()).toBe(true));

    clock.advance(400);
    gate.reject(boom);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(
      { err: boom, durationMs: 400, cooldownMapSize: 7 },
      "memory candidate reconciliation tick failed",
    ));
  });

  it("clamps duration to 0 when the clock appears to go backwards mid-tick", async () => {
    const harness = fakeTimerHarness();
    const clock = fakeClock(1_000);
    const gate = deferred<Record<string, unknown>>();
    const logger = silentLogger();
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile: vi.fn().mockReturnValue(gate.promise),
      intervalMs: 60_000,
      logger,
      now: clock.now,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();
    await vi.waitFor(() => expect(scheduler.isTickInFlight()).toBe(true));

    clock.set(900); // a system-clock step backwards, not a real elapsed time
    gate.resolve({});
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith(
      { result: {}, durationMs: 0 },
      "memory candidate reconciliation tick completed",
    ));
  });

  it("logs the in-flight skip exactly once and does not start a second reconcile when the interval fires mid-tick", async () => {
    const harness = fakeTimerHarness();
    const gate = deferred<Record<string, unknown>>();
    const reconcile = vi.fn().mockReturnValue(gate.promise);
    const logger = silentLogger();
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile,
      intervalMs: 60_000,
      logger,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(scheduler.isTickInFlight()).toBe(true);

    harness.fireInterval();
    expect(reconcile).toHaveBeenCalledTimes(1); // no second reconcile started
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      {},
      "memory candidate reconciliation tick skipped; previous tick still in flight",
    );

    gate.resolve({});
    await vi.waitFor(() => expect(scheduler.isTickInFlight()).toBe(false));

    // The next interval firing, after the previous tick actually finished, runs normally.
    harness.fireInterval();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
  });

  it("does not start a tick or log a skip when the interval fires after stop()", async () => {
    const harness = fakeTimerHarness();
    const reconcile = vi.fn().mockResolvedValue({});
    const logger = silentLogger();
    const scheduler = createMemoryCandidateReconcilerScheduler({
      reconcile,
      intervalMs: 60_000,
      logger,
      setIntervalFn: harness.setIntervalFn,
      clearIntervalFn: harness.clearIntervalFn,
    });

    scheduler.start();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(scheduler.isTickInFlight()).toBe(false));

    await scheduler.stop();
    reconcile.mockClear();
    logger.info.mockClear();

    // The fake harness's captured handler still exists even though
    // clearIntervalFn was called against it — this proves the scheduler's
    // own internal stopped-guard is what makes a post-stop firing inert,
    // not just the real clearInterval call.
    harness.fireInterval();
    await Promise.resolve();
    await Promise.resolve();
    expect(reconcile).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
