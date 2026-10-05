import { describe, expect, it } from "vitest";
import { recoveryAction } from "../../../scripts/operations/recovery-policy.mjs";

const baseArgs = {
  apiReady: false,
  dbReady: false,
  runtimeAlive: false,
  appPortOpen: false,
  dbPortOpen: false,
  attempts: 0,
  now: 1_000,
  nextAttemptAt: 0,
};

describe("recoveryAction", () => {
  it("returns healthy when both api and db are ready", () => {
    expect(recoveryAction({ ...baseArgs, apiReady: true, dbReady: true })).toBe("healthy");
  });

  it("returns healthy even if a stale runtime/port flag is still set, as long as both dimensions are ready", () => {
    expect(
      recoveryAction({ ...baseArgs, apiReady: true, dbReady: true, runtimeAlive: true, appPortOpen: true }),
    ).toBe("healthy");
  });

  it("DEFECT_2 fix: db alive + api dead + runtime dead + app port free returns start (was manual-attention)", () => {
    expect(
      recoveryAction({
        ...baseArgs,
        apiReady: false,
        dbReady: true,
        runtimeAlive: false,
        appPortOpen: false,
        dbPortOpen: true,
      }),
    ).toBe("start");
  });

  it("app port occupied returns manual-attention even when db is alive and runtime is not tracked", () => {
    expect(
      recoveryAction({
        ...baseArgs,
        apiReady: false,
        dbReady: true,
        runtimeAlive: false,
        appPortOpen: true,
        dbPortOpen: true,
      }),
    ).toBe("manual-attention");
  });

  it("tracked runtime alive returns manual-attention regardless of port state", () => {
    expect(
      recoveryAction({
        ...baseArgs,
        apiReady: false,
        dbReady: false,
        runtimeAlive: true,
        appPortOpen: false,
      }),
    ).toBe("manual-attention");
  });

  it("returns cooldown when not enough time has passed since the last attempt", () => {
    expect(
      recoveryAction({ ...baseArgs, attempts: 1, now: 1_000, nextAttemptAt: 5_000 }),
    ).toBe("cooldown");
  });

  it("returns exhausted after 3 attempts", () => {
    expect(recoveryAction({ ...baseArgs, attempts: 3 })).toBe("exhausted");
  });

  it("regression: fully dead app+db with no runtime and no ports open still returns start", () => {
    expect(
      recoveryAction({
        ...baseArgs,
        apiReady: false,
        dbReady: false,
        runtimeAlive: false,
        appPortOpen: false,
        dbPortOpen: false,
      }),
    ).toBe("start");
  });
});
