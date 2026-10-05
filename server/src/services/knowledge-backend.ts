import type { KnowledgeRecord } from "@paperclipai/shared";
import { resolveObsidianVaultRoot } from "./obsidian-vault-config.js";
import { syncKnowledgeRecordToObsidian, type ObsidianSyncOutcome } from "./obsidian-sync.js";

// F-08 Pluggable Knowledge Backend — the smallest useful abstraction over
// "write a promoted Knowledge Record somewhere external." Obsidian remains
// the only real implementation in v1; this module exists so the knowledge
// service calls a generic interface instead of importing obsidian-sync.ts
// directly, matching the registration-pattern precedent already established
// by server/src/adapters/registry.ts and server/src/storage/provider-registry.ts.
//
// Deliberately NOT built: a read capability, bidirectional sync, fan-out to
// multiple backends, or a DB-stored per-company backend selection. See
// docs/contracts/nexora-f08-knowledge-backend-architecture.md.

export const KNOWLEDGE_BACKEND_ENV_VAR = "PAPERCLIP_KNOWLEDGE_BACKEND";

export type KnowledgeBackendWriteInput = Pick<
  KnowledgeRecord,
  "id" | "companyId" | "title" | "summary" | "body"
> & {
  /** The backend's own identifier for this record from a prior write (e.g. a vault-relative path), or null if never synced. */
  externalRef: string | null;
};

export type KnowledgeBackendWriteResult =
  | { state: "synced"; externalRef: string }
  | { state: "failed"; error: string };

export interface KnowledgeBackend {
  /** Stable backend identifier, e.g. "obsidian". Persisted to knowledge_records.externalBackendId on every write attempt. */
  id: string;
  capabilities: {
    write: boolean;
    /** Reserved for a future read-capable backend. No backend implements this in v1 — sync stays one-way/push-only. */
    read: boolean;
  };
  writeRecord(input: KnowledgeBackendWriteInput): Promise<KnowledgeBackendWriteResult>;
}

/** Legacy Obsidian-level sync function shape — predates this module, kept for the existing obsidian-sync test injection seam. */
export type ObsidianSyncFn = (
  vaultRoot: string | null,
  record: Parameters<typeof syncKnowledgeRecordToObsidian>[1],
) => Promise<ObsidianSyncOutcome>;

export type ObsidianKnowledgeBackendOptions = {
  obsidianVaultRoot?: string | null;
  /** Test-only seam: overrides the actual filesystem sync implementation. */
  obsidianSyncFn?: ObsidianSyncFn;
};

/**
 * Obsidian as the v1 (and only) KnowledgeBackend implementation. Wraps
 * syncKnowledgeRecordToObsidian unchanged — no internal Obsidian behavior
 * (vault containment, Markdown/YAML rendering, atomic write, error
 * sanitization) is modified by this adapter.
 */
export function createObsidianKnowledgeBackend(
  options: ObsidianKnowledgeBackendOptions = {},
): KnowledgeBackend {
  const vaultRoot = options.obsidianVaultRoot !== undefined
    ? options.obsidianVaultRoot
    : resolveObsidianVaultRoot();
  const runSync: ObsidianSyncFn = options.obsidianSyncFn ?? syncKnowledgeRecordToObsidian;

  return {
    id: "obsidian",
    capabilities: { write: true, read: false },
    async writeRecord(input) {
      const outcome = await runSync(vaultRoot, {
        id: input.id,
        companyId: input.companyId,
        title: input.title,
        summary: input.summary,
        body: input.body,
        obsidianPath: input.externalRef,
      });
      if (outcome.state === "synced") {
        return { state: "synced", externalRef: outcome.relativePath };
      }
      return { state: "failed", error: outcome.error };
    },
  };
}

export class UnknownKnowledgeBackendError extends Error {}

/**
 * Resolves a KnowledgeBackend by id. Fails closed: an unrecognized id throws
 * rather than silently falling back to Obsidian or any other default.
 */
export function getKnowledgeBackend(
  id: string,
  options: ObsidianKnowledgeBackendOptions = {},
): KnowledgeBackend {
  if (id === "obsidian") {
    return createObsidianKnowledgeBackend(options);
  }
  throw new UnknownKnowledgeBackendError(`Unknown knowledge backend: "${id}"`);
}

/**
 * The one active backend for this server instance, selected the same way
 * obsidian-vault-config.ts and storage/provider-registry.ts already select
 * their single active implementation: a server-owned env var, never a
 * client-supplied or per-company value. Defaults to "obsidian" — the only
 * real backend in v1.
 */
export function getActiveKnowledgeBackendId(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env[KNOWLEDGE_BACKEND_ENV_VAR]?.trim();
  return raw ? raw : "obsidian";
}
