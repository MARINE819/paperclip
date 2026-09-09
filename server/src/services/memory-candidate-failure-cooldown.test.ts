import { describe, expect, it } from "vitest";
import { createFailureCooldownTracker } from "./memory-candidate-failure-cooldown.js";

/** A controllable, injectable clock — no real sleeps anywhere in this file. */
function fakeClock(startAt = 0) {
  let now = startAt;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createFailureCooldownTracker", () => {
  it("is not in cooldown before any failure is recorded", () => {
    const tracker = createFailureCooldownTracker();
    expect(tracker.isInCooldown("issue-1")).toBe(false);
  });

  it("enters cooldown after a failure and leaves cooldown once the duration elapses", () => {
    const clock = fakeClock();
    const tracker = createFailureCooldownTracker({ cooldownMs: 1000, now: clock.now });

    tracker.recordFailure("issue-1");
    expect(tracker.isInCooldown("issue-1")).toBe(true);

    clock.advance(999);
    expect(tracker.isInCooldown("issue-1")).toBe(true);

    clock.advance(2); // now past 1000ms since the failure
    expect(tracker.isInCooldown("issue-1")).toBe(false);
  });

  it("does not cool down unrelated keys", () => {
    const tracker = createFailureCooldownTracker({ cooldownMs: 60_000 });
    tracker.recordFailure("issue-1");
    expect(tracker.isInCooldown("issue-2")).toBe(false);
  });

  it("clears cooldown immediately on recordSuccess", () => {
    const tracker = createFailureCooldownTracker({ cooldownMs: 60_000 });
    tracker.recordFailure("issue-1");
    expect(tracker.isInCooldown("issue-1")).toBe(true);
    tracker.recordSuccess("issue-1");
    expect(tracker.isInCooldown("issue-1")).toBe(false);
  });

  it("rate-limits repeated log lines for the same key within the log window", () => {
    const clock = fakeClock();
    const tracker = createFailureCooldownTracker({ cooldownMs: 100, logRateLimitMs: 1000, now: clock.now });

    const first = tracker.recordFailure("issue-1");
    expect(first).toEqual({ shouldLog: true, failureCount: 1 });

    clock.advance(500); // still within the 1000ms log window
    const second = tracker.recordFailure("issue-1");
    expect(second).toEqual({ shouldLog: false, failureCount: 2 });

    clock.advance(600); // now 1100ms since the first log — past the window
    const third = tracker.recordFailure("issue-1");
    expect(third).toEqual({ shouldLog: true, failureCount: 3 });
  });

  it("tracks failure counts independently per key", () => {
    const tracker = createFailureCooldownTracker({ cooldownMs: 60_000 });
    tracker.recordFailure("issue-1");
    tracker.recordFailure("issue-1");
    const forOther = tracker.recordFailure("issue-2");
    expect(forOther.failureCount).toBe(1);
  });

  it("stays bounded and evicts the soonest-to-expire entries when full", () => {
    const clock = fakeClock();
    const tracker = createFailureCooldownTracker({ cooldownMs: 1000, maxEntries: 3, now: clock.now });

    // issue-a fails first (expires soonest), then b, then c, then a fresh
    // failure pushes the tracker over its bound with issue-d.
    tracker.recordFailure("issue-a");
    clock.advance(10);
    tracker.recordFailure("issue-b");
    clock.advance(10);
    tracker.recordFailure("issue-c");
    expect(tracker.size()).toBe(3);

    clock.advance(10);
    tracker.recordFailure("issue-d");
    expect(tracker.size()).toBe(3); // bound enforced, not 4

    // issue-a had the earliest cooldownUntil, so it must be the one evicted.
    expect(tracker.isInCooldown("issue-a")).toBe(false);
    expect(tracker.isInCooldown("issue-d")).toBe(true);
  });

  it("does not grow unbounded even after many distinct keys fail once each", () => {
    const tracker = createFailureCooldownTracker({ cooldownMs: 60_000, maxEntries: 50 });
    for (let i = 0; i < 500; i += 1) {
      tracker.recordFailure(`issue-${i}`);
    }
    expect(tracker.size()).toBeLessThanOrEqual(50);
  });
});
