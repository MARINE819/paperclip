import { describe, expect, it } from "vitest";
import {
  resolveGitSaveIdleReminderConfig,
  GIT_SAVE_IDLE_REMINDER_ENV_VARS,
  GIT_SAVE_IDLE_REMINDER_DEFAULT_ENABLED,
  GIT_SAVE_IDLE_REMINDER_DEFAULT_INTERVAL_MS,
  GIT_SAVE_IDLE_REMINDER_MIN_INTERVAL_MS,
} from "./git-save-idle-reminder-config.js";

describe("resolveGitSaveIdleReminderConfig", () => {
  it("defaults to disabled when the env var is unset", () => {
    const config = resolveGitSaveIdleReminderConfig({});
    expect(config.enabled).toBe(GIT_SAVE_IDLE_REMINDER_DEFAULT_ENABLED);
    expect(config.enabled).toBe(false);
  });

  it("stays disabled for any value other than the exact string 'true'", () => {
    expect(resolveGitSaveIdleReminderConfig({ [GIT_SAVE_IDLE_REMINDER_ENV_VARS.ENABLED]: "1" }).enabled).toBe(false);
    expect(resolveGitSaveIdleReminderConfig({ [GIT_SAVE_IDLE_REMINDER_ENV_VARS.ENABLED]: "yes" }).enabled).toBe(false);
    expect(resolveGitSaveIdleReminderConfig({ [GIT_SAVE_IDLE_REMINDER_ENV_VARS.ENABLED]: "TRUE" }).enabled).toBe(false);
  });

  it("enables only on the exact string 'true'", () => {
    const config = resolveGitSaveIdleReminderConfig({ [GIT_SAVE_IDLE_REMINDER_ENV_VARS.ENABLED]: "true" });
    expect(config.enabled).toBe(true);
  });

  it("uses the default interval when unset", () => {
    const config = resolveGitSaveIdleReminderConfig({});
    expect(config.intervalMs).toBe(GIT_SAVE_IDLE_REMINDER_DEFAULT_INTERVAL_MS);
  });

  it("clamps an interval below the minimum up to the minimum", () => {
    const config = resolveGitSaveIdleReminderConfig({
      [GIT_SAVE_IDLE_REMINDER_ENV_VARS.INTERVAL_MS]: "1000",
    });
    expect(config.intervalMs).toBe(GIT_SAVE_IDLE_REMINDER_MIN_INTERVAL_MS);
  });

  it("honors a valid interval above the minimum", () => {
    const config = resolveGitSaveIdleReminderConfig({
      [GIT_SAVE_IDLE_REMINDER_ENV_VARS.INTERVAL_MS]: "120000",
    });
    expect(config.intervalMs).toBe(120000);
  });

  it("falls back to the default interval for a malformed value", () => {
    const config = resolveGitSaveIdleReminderConfig({
      [GIT_SAVE_IDLE_REMINDER_ENV_VARS.INTERVAL_MS]: "not-a-number",
    });
    expect(config.intervalMs).toBe(GIT_SAVE_IDLE_REMINDER_DEFAULT_INTERVAL_MS);
  });
});
