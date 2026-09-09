/**
 * Server-owned configuration for the Phase 3.0B automatic Memory Operation
 * candidate reconciler. Same pattern as `obsidian-vault-config.ts`: plain
 * `PAPERCLIP_*` environment variables, read through an injectable `env`
 * object so tests never need to mutate `process.env`.
 *
 * Fail-closed: any missing or malformed value falls back to a safe default
 * rather than throwing or silently disabling in a surprising way.
 * `ENABLED` in particular fails closed to `false` — Phase 3.0B ships
 * disabled by default during implementation/UAT (see
 * `doc/memory-candidate-extraction.md`); enabling it is a deliberate
 * operator decision, never the default.
 */

export const MEMORY_CANDIDATE_RECONCILER_ENV_VARS = {
  ENABLED: "PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED",
  INTERVAL_MS: "PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS",
  BATCH_SIZE: "PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_BATCH_SIZE",
} as const;

export const MEMORY_CANDIDATE_RECONCILER_DEFAULT_ENABLED = false;
export const MEMORY_CANDIDATE_RECONCILER_DEFAULT_INTERVAL_MS = 60_000;
export const MEMORY_CANDIDATE_RECONCILER_MIN_INTERVAL_MS = 10_000;
export const MEMORY_CANDIDATE_RECONCILER_DEFAULT_BATCH_SIZE = 20;
export const MEMORY_CANDIDATE_RECONCILER_MAX_BATCH_SIZE = 200;

export interface MemoryCandidateReconcilerConfig {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export function resolveMemoryCandidateReconcilerConfig(
  env: Record<string, string | undefined> = process.env,
): MemoryCandidateReconcilerConfig {
  // Fail closed: only the exact string "true" enables it. Anything else
  // (unset, "1", "yes", a typo) stays disabled rather than guessing intent.
  const enabled = env[MEMORY_CANDIDATE_RECONCILER_ENV_VARS.ENABLED] === "true";

  const parsedInterval = parsePositiveInt(env[MEMORY_CANDIDATE_RECONCILER_ENV_VARS.INTERVAL_MS]);
  const intervalMs = Math.max(
    MEMORY_CANDIDATE_RECONCILER_MIN_INTERVAL_MS,
    parsedInterval ?? MEMORY_CANDIDATE_RECONCILER_DEFAULT_INTERVAL_MS,
  );

  const parsedBatchSize = parsePositiveInt(env[MEMORY_CANDIDATE_RECONCILER_ENV_VARS.BATCH_SIZE]);
  const batchSize = Math.min(
    MEMORY_CANDIDATE_RECONCILER_MAX_BATCH_SIZE,
    parsedBatchSize ?? MEMORY_CANDIDATE_RECONCILER_DEFAULT_BATCH_SIZE,
  );

  return { enabled, intervalMs, batchSize };
}
