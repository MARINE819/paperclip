import { and, eq, ne } from "drizzle-orm";
import { agentApiKeys, boardApiKeys, companySecrets } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { maskFromHash } from "./secret-masking.js";

// F-02 Secrets/Credential Management — a READ-ONLY projection unifying
// three already-existing, already-tested, separately-owned credential
// tables into one consistent metadata shape. This service never creates,
// rotates, or revokes anything — those operations already exist and stay
// exactly where they are (server/src/routes/secrets.ts for company
// secrets, server/src/routes/access.ts for agent/board API keys). It also
// never touches `company_secret_versions.material` (the encrypted
// payload) — plaintext is structurally unreachable from this file.

export type SecretsRegistryEntryType = "secret" | "agent_api_key" | "board_api_key";

export type SecretsRegistryEntry = {
  id: string;
  type: SecretsRegistryEntryType;
  provider: string | null;
  ownerType: "company" | "user" | "agent";
  ownerId: string;
  scope: string;
  status: string;
  maskedIdentifier: string | null;
  label: string | null;
  createdAt: string;
  updatedAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
};

function computeHashCredentialStatus(revokedAt: Date | null, expiresAt: Date | null | undefined, now: number): string {
  if (revokedAt) return "revoked";
  if (expiresAt && expiresAt.getTime() < now) return "expired";
  return "active";
}

async function listCompanySecretEntries(db: Db, companyId: string): Promise<SecretsRegistryEntry[]> {
  const rows = await db
    .select()
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), ne(companySecrets.status, "deleted")));

  return rows.map((row) => ({
    id: row.id,
    type: "secret",
    provider: row.provider,
    ownerType: row.scope === "user" ? "user" : "company",
    ownerId: row.scope === "user" ? (row.ownerUserId ?? row.companyId) : row.companyId,
    scope: row.scope,
    status: row.status,
    // Never a plaintext preview — see secret-masking.ts. The secret's own
    // non-sensitive key/name label is the identifying display field.
    maskedIdentifier: null,
    label: row.name ?? row.key,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastResolvedAt ? row.lastResolvedAt.toISOString() : null,
    expiresAt: null,
    revokedAt: null,
    createdBy: row.createdByUserId ?? row.createdByAgentId ?? null,
  }));
}

async function listAgentApiKeyEntries(db: Db, companyId: string, now: number): Promise<SecretsRegistryEntry[]> {
  const rows = await db.select().from(agentApiKeys).where(eq(agentApiKeys.companyId, companyId));
  return rows.map((row) => ({
    id: row.id,
    type: "agent_api_key",
    provider: "paperclip",
    ownerType: "agent",
    ownerId: row.agentId,
    scope: "agent",
    status: computeHashCredentialStatus(row.revokedAt, null, now),
    maskedIdentifier: maskFromHash(row.keyHash),
    label: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdBy: null,
  }));
}

/** Board API keys are user-owned, never company-scoped — always filtered to the requesting user's own keys, never another user's. */
async function listBoardApiKeyEntries(db: Db, requestingUserId: string, now: number): Promise<SecretsRegistryEntry[]> {
  const rows = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, requestingUserId));
  return rows.map((row) => ({
    id: row.id,
    type: "board_api_key",
    provider: "paperclip",
    ownerType: "user",
    ownerId: row.userId,
    scope: row.scope ?? "unrestricted",
    status: computeHashCredentialStatus(row.revokedAt, row.expiresAt, now),
    maskedIdentifier: maskFromHash(row.keyHash),
    label: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdBy: null,
  }));
}

export type ListSecretsRegistryInput = {
  companyId: string;
  requestingUserId: string;
  type?: SecretsRegistryEntryType;
};

/**
 * Company-scoped by design (not instance-wide) — secrets carry materially
 * higher blast-radius than F-04/F-05/F-06's registries, so a caller must
 * name exactly one company. Board API keys, which have no company
 * dimension at all, are always filtered to the requesting user's own
 * keys regardless of which companyId was passed.
 */
export async function listSecretsRegistry(db: Db, input: ListSecretsRegistryInput): Promise<SecretsRegistryEntry[]> {
  const now = Date.now();
  const [secrets, agentKeys, boardKeys] = await Promise.all([
    listCompanySecretEntries(db, input.companyId),
    listAgentApiKeyEntries(db, input.companyId, now),
    listBoardApiKeyEntries(db, input.requestingUserId, now),
  ]);
  const all = [...secrets, ...agentKeys, ...boardKeys];
  return input.type ? all.filter((e) => e.type === input.type) : all;
}

export async function getSecretsRegistryEntry(
  db: Db,
  id: string,
  input: { companyId: string; requestingUserId: string },
): Promise<SecretsRegistryEntry | null> {
  const all = await listSecretsRegistry(db, input);
  return all.find((e) => e.id === id) ?? null;
}
