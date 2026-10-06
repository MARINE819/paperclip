/**
 * Server-owned configuration for the Phase 3.0B automatic Memory Operation
 * candidate reconciler. Same pattern as `obsidian-vault-config.ts`: plain
 * `PAPERCLIP_*` environment variables, read through an injectable `env`
 * object so tests never need to mutate `process.env`.
 *
 * Missing configuration uses the enabled production default. Explicit
 * configuration is fail-closed: only exact `"true"` enables the reconciler;
 * exact `"false"` and every malformed explicit value disable it.
 */

export const MEMORY_CANDIDATE_RECONCILER_ENV_VARS = {
  ENABLED: "PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED",
  INTERVAL_MS: "PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS",
  BATCH_SIZE: "PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_BATCH_SIZE",
} as const;

export const MEMORY_CANDIDATE_RECONCILER_DEFAULT_ENABLED = true;
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
  const rawEnabled = env[MEMORY_CANDIDATE_RECONCILER_ENV_VARS.ENABLED];
  // Unset uses the enabled production default. Any explicit value other than
  // the exact string "true" disables the pipeline, so typos fail closed.
  const enabled = rawEnabled === undefined
    ? MEMORY_CANDIDATE_RECONCILER_DEFAULT_ENABLED
    : rawEnabled === "true";

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
