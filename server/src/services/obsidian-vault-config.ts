/**
 * Server-owned Obsidian vault root configuration.
 *
 * Phase 2.2 deliberately does not introduce a general-purpose settings
 * system for this. The vault root is a filesystem path an operator controls
 * on the machine running the server, so it is resolved the same way other
 * server-owned filesystem roots are in this codebase (see the
 * `PAPERCLIP_*` env vars in `server/src/config.ts`, e.g.
 * `PAPERCLIP_STORAGE_LOCAL_DIR`, `PAPERCLIP_DB_BACKUP_DIR`): an environment
 * variable, with the environment object accepted as a parameter so callers
 * (and tests) can inject an isolated value without touching `process.env`.
 *
 * The client never supplies this value — see `server/src/services/obsidian-sync.ts`.
 */
export const OBSIDIAN_VAULT_ROOT_ENV_VAR = "PAPERCLIP_OBSIDIAN_VAULT_ROOT";

export function resolveObsidianVaultRoot(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[OBSIDIAN_VAULT_ROOT_ENV_VAR]?.trim();
  return raw ? raw : null;
}
