/**
 * Server-owned configuration for the SYNC-02 daily (21:00 KST) Git-save
 * reminder scheduler. Same pattern as `knowledge-auto-save-config.ts` /
 * `memory-candidate-reconciler-config.ts`: plain `PAPERCLIP_*` environment
 * variables, read through an injectable `env` object so tests never need to
 * mutate `process.env`.
 *
 * Fail-closed: `ENABLED` defaults to `false` -- the reminder ships disabled
 * by default; enabling it is a deliberate operator decision, never the
 * default, matching the exact precedent set by
 * `KNOWLEDGE_AUTO_SAVE_DEFAULT_ENABLED`.
 */

export const GIT_SAVE_DAILY_REMINDER_ENV_VARS = {
  ENABLED: "PAPERCLIP_SYNC02_DAILY_REMINDER_ENABLED",
  INTERVAL_MS: "PAPERCLIP_SYNC02_DAILY_REMINDER_INTERVAL_MS",
} as const;

export const GIT_SAVE_DAILY_REMINDER_DEFAULT_ENABLED = false;
export const GIT_SAVE_DAILY_REMINDER_DEFAULT_INTERVAL_MS = 5 * 60_000;
export const GIT_SAVE_DAILY_REMINDER_MIN_INTERVAL_MS = 60_000;

export interface GitSaveDailyReminderConfig {
  enabled: boolean;
  intervalMs: number;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export function resolveGitSaveDailyReminderConfig(
  env: Record<string, string | undefined> = process.env,
): GitSaveDailyReminderConfig {
  // Fail closed: only the exact string "true" enables it. Anything else
  // (unset, "1", "yes", a typo) stays disabled rather than guessing intent.
  const enabled = env[GIT_SAVE_DAILY_REMINDER_ENV_VARS.ENABLED] === "true";

  const parsedInterval = parsePositiveInt(env[GIT_SAVE_DAILY_REMINDER_ENV_VARS.INTERVAL_MS]);
  const intervalMs = Math.max(
    GIT_SAVE_DAILY_REMINDER_MIN_INTERVAL_MS,
    parsedInterval ?? GIT_SAVE_DAILY_REMINDER_DEFAULT_INTERVAL_MS,
  );

  return { enabled, intervalMs };
}
