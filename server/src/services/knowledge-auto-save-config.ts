/**
 * Server-owned configuration for the F-07 automatic Knowledge Record backend
 * save reconciler. Same pattern as `memory-candidate-reconciler-config.ts`
 * (Phase 3.0B) and `obsidian-vault-config.ts`: plain `PAPERCLIP_*`
 * environment variables, read through an injectable `env` object so tests
 * never need to mutate `process.env`.
 *
 * Fail-closed: any missing or malformed value falls back to a safe default
 * rather than throwing or silently misbehaving. `ENABLED` in particular
 * fails closed to `false` — automatic background writes to an external
 * knowledge backend ship disabled by default; enabling it is a deliberate
 * operator decision, never the default, matching the exact precedent set by
 * `MEMORY_CANDIDATE_RECONCILER_DEFAULT_ENABLED`.
 */

export const KNOWLEDGE_AUTO_SAVE_ENV_VARS = {
  ENABLED: "PAPERCLIP_KNOWLEDGE_AUTO_SAVE_ENABLED",
  INTERVAL_MS: "PAPERCLIP_KNOWLEDGE_AUTO_SAVE_INTERVAL_MS",
  BATCH_SIZE: "PAPERCLIP_KNOWLEDGE_AUTO_SAVE_BATCH_SIZE",
} as const;

export const KNOWLEDGE_AUTO_SAVE_DEFAULT_ENABLED = false;
export const KNOWLEDGE_AUTO_SAVE_DEFAULT_INTERVAL_MS = 60_000;
export const KNOWLEDGE_AUTO_SAVE_MIN_INTERVAL_MS = 10_000;
export const KNOWLEDGE_AUTO_SAVE_DEFAULT_BATCH_SIZE = 20;
export const KNOWLEDGE_AUTO_SAVE_MAX_BATCH_SIZE = 200;

export interface KnowledgeAutoSaveConfig {
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

export function resolveKnowledgeAutoSaveConfig(
  env: Record<string, string | undefined> = process.env,
): KnowledgeAutoSaveConfig {
  // Fail closed: only the exact string "true" enables it. Anything else
  // (unset, "1", "yes", a typo) stays disabled rather than guessing intent.
  const enabled = env[KNOWLEDGE_AUTO_SAVE_ENV_VARS.ENABLED] === "true";

  const parsedInterval = parsePositiveInt(env[KNOWLEDGE_AUTO_SAVE_ENV_VARS.INTERVAL_MS]);
  const intervalMs = Math.max(
    KNOWLEDGE_AUTO_SAVE_MIN_INTERVAL_MS,
    parsedInterval ?? KNOWLEDGE_AUTO_SAVE_DEFAULT_INTERVAL_MS,
  );

  const parsedBatchSize = parsePositiveInt(env[KNOWLEDGE_AUTO_SAVE_ENV_VARS.BATCH_SIZE]);
  const batchSize = Math.min(
    KNOWLEDGE_AUTO_SAVE_MAX_BATCH_SIZE,
    parsedBatchSize ?? KNOWLEDGE_AUTO_SAVE_DEFAULT_BATCH_SIZE,
  );

  return { enabled, intervalMs, batchSize };
}
