import { and, desc, eq, inArray } from "drizzle-orm";
import {
  plugins,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { ToolRiskLevel, ToolTrustStatus } from "@paperclipai/shared";
import type { TrustRegistryEntrySnapshot, TrustRegistryEntryType } from "./tool-trust-decision.js";

export type TrustRegistryRow = TrustRegistryEntrySnapshot & {
  companyId: string | null;
  createdAt: string;
  updatedAt: string;
};

type TrustRulePolicyConfig = {
  trustRule?: {
    revokedAt?: string | null;
    expiresAt?: string | null;
  };
};

/**
 * Derives a tool catalog entry's ToolTrustStatus from the EXISTING policy
 * engine's data (never a second source of truth): a matching enabled
 * `block` policy, or the catalog entry's own `quarantined` status, means
 * "blocked"; a matching `trust_rule` policy with `revokedAt` set means
 * "revoked"; a live (non-revoked, non-expired) `trust_rule` match means
 * "trusted"; anything else is "unreviewed" — the only safe default. This
 * function intentionally never derives "restricted" for tools: nothing in
 * the existing policy data distinguishes a genuinely narrower grant from a
 * full one without over-interpreting argument-hash filters. "restricted"
 * is reachable today only via the plugin trust-review write path, which
 * sets it explicitly.
 */
function deriveToolTrustStatus(
  catalogStatus: string,
  matchingPolicies: Array<{ policyType: string; config: unknown }>,
): ToolTrustStatus {
  if (catalogStatus === "quarantined") return "blocked";
  const blockPolicy = matchingPolicies.find((p) => p.policyType === "block");
  if (blockPolicy) return "blocked";
  const trustRule = matchingPolicies.find((p) => p.policyType === "trust_rule");
  if (trustRule) {
    const config = trustRule.config as TrustRulePolicyConfig | null;
    const rule = config?.trustRule;
    if (rule?.revokedAt) return "revoked";
    if (rule?.expiresAt && new Date(rule.expiresAt).getTime() < Date.now()) return "unreviewed";
    return "trusted";
  }
  return "unreviewed";
}

async function listToolTrustEntries(db: Db): Promise<TrustRegistryRow[]> {
  const rows = await db
    .select({
      id: toolCatalogEntries.id,
      companyId: toolCatalogEntries.companyId,
      name: toolCatalogEntries.name,
      version: toolCatalogEntries.version,
      versionHash: toolCatalogEntries.versionHash,
      riskLevel: toolCatalogEntries.riskLevel,
      status: toolCatalogEntries.status,
      signature: toolCatalogEntries.signature,
      signatureVerified: toolCatalogEntries.signatureVerified,
      sourceUrl: toolCatalogEntries.sourceUrl,
      reviewedAt: toolCatalogEntries.reviewedAt,
      reviewedByUserId: toolCatalogEntries.reviewedByUserId,
      reviewedByAgentId: toolCatalogEntries.reviewedByAgentId,
      createdAt: toolCatalogEntries.createdAt,
      updatedAt: toolCatalogEntries.updatedAt,
      connectionTransport: toolConnections.transport,
      connectionEnabled: toolConnections.enabled,
      applicationName: toolApplications.name,
    })
    .from(toolCatalogEntries)
    .innerJoin(toolConnections, eq(toolCatalogEntries.connectionId, toolConnections.id))
    .innerJoin(toolApplications, eq(toolConnections.applicationId, toolApplications.id))
    .orderBy(desc(toolCatalogEntries.updatedAt));

  if (rows.length === 0) return [];

  const entryIds = rows.map((r) => r.id);
  const policyRows = await db
    .select({
      policyType: toolPolicies.policyType,
      config: toolPolicies.config,
      selectors: toolPolicies.selectors,
    })
    .from(toolPolicies)
    .where(
      and(
        eq(toolPolicies.enabled, true),
        inArray(toolPolicies.policyType, ["block", "trust_rule"]),
      ),
    );

  const policiesByEntryId = new Map<string, Array<{ policyType: string; config: unknown }>>();
  for (const policy of policyRows) {
    const selectors = (policy.selectors ?? {}) as Record<string, unknown>;
    const single = typeof selectors.catalogEntryId === "string" ? [selectors.catalogEntryId] : [];
    const many = Array.isArray(selectors.catalogEntryIds)
      ? selectors.catalogEntryIds.filter((v): v is string => typeof v === "string")
      : [];
    for (const id of [...single, ...many]) {
      if (!entryIds.includes(id)) continue;
      const list = policiesByEntryId.get(id) ?? [];
      list.push({ policyType: policy.policyType, config: policy.config });
      policiesByEntryId.set(id, list);
    }
  }

  return rows.map((row) => {
    const type: TrustRegistryEntryType = row.connectionTransport === "mcp_remote" ? "mcp" : "tool";
    const trustStatus = deriveToolTrustStatus(row.status, policiesByEntryId.get(row.id) ?? []);
    return {
      id: row.id,
      type,
      name: row.name,
      provider: row.applicationName,
      version: row.version,
      versionHash: row.versionHash,
      source: row.connectionTransport,
      sourceUrl: row.sourceUrl,
      trustStatus,
      riskLevel: row.riskLevel,
      // Tool-level scope control already happens via the existing
      // argument-hash trust_rule system, not a named-scope array — see
      // docs/contracts/nexora-f05-tool-trust-api.md.
      requestedScopes: [],
      approvedScopes: [],
      signature: row.signature,
      signatureVerified: row.signatureVerified,
      enabled: row.connectionEnabled,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewedBy: row.reviewedByUserId ?? row.reviewedByAgentId ?? null,
      companyId: row.companyId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

async function listPluginTrustEntries(db: Db): Promise<TrustRegistryRow[]> {
  const rows = await db.select().from(plugins).orderBy(desc(plugins.updatedAt));
  return rows.map((row) => ({
    id: row.id,
    type: "plugin" as const,
    name: row.pluginKey,
    provider: row.packageName,
    version: row.version,
    versionHash: null,
    source: "plugin",
    sourceUrl: row.sourceUrl,
    trustStatus: row.trustStatus,
    riskLevel: row.riskLevel,
    requestedScopes: row.requestedScopes,
    approvedScopes: row.approvedScopes,
    signature: row.signature,
    signatureVerified: row.signatureVerified,
    enabled: row.status !== "disabled" && row.status !== "uninstalled",
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewedBy: row.reviewedByUserId,
    companyId: null,
    createdAt: row.installedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export type TrustRegistryFilters = {
  type?: TrustRegistryEntryType;
  trustStatus?: ToolTrustStatus;
  enabled?: boolean;
};

function applyFilters(entries: TrustRegistryRow[], filters: TrustRegistryFilters): TrustRegistryRow[] {
  return entries.filter((e) => {
    if (filters.type && e.type !== filters.type) return false;
    if (filters.trustStatus && e.trustStatus !== filters.trustStatus) return false;
    if (filters.enabled !== undefined && e.enabled !== filters.enabled) return false;
    return true;
  });
}

/** Instance-wide (all companies) registry list — Tool/MCP entries derived live from the existing policy engine, Plugin entries read directly. */
export async function listTrustRegistry(db: Db, filters: TrustRegistryFilters = {}): Promise<TrustRegistryRow[]> {
  const [toolEntries, pluginEntries] = await Promise.all([listToolTrustEntries(db), listPluginTrustEntries(db)]);
  return applyFilters([...toolEntries, ...pluginEntries], filters);
}

export async function getTrustRegistryEntry(db: Db, id: string): Promise<TrustRegistryRow | null> {
  const all = await listTrustRegistry(db);
  return all.find((e) => e.id === id) ?? null;
}

export class PluginNotFoundError extends Error {
  constructor(id: string) {
    super(`Plugin ${id} not found`);
    this.name = "PluginNotFoundError";
  }
}

export type ReviewPluginTrustInput = {
  pluginId: string;
  trustStatus: ToolTrustStatus;
  riskLevel?: ToolRiskLevel | null;
  approvedScopes?: string[];
  reviewedByUserId: string;
};

/**
 * The ONLY write path that can move a plugin's trustStatus. Requires a
 * human userId — there is no agent-reviewer parameter, structurally
 * preventing an agent from ever being recorded as its own (or any) trust
 * reviewer. Never called automatically; always an explicit admin action.
 */
export async function reviewPluginTrust(db: Db, input: ReviewPluginTrustInput): Promise<TrustRegistryRow> {
  const existing = await db.select().from(plugins).where(eq(plugins.id, input.pluginId)).limit(1);
  if (!existing[0]) throw new PluginNotFoundError(input.pluginId);

  const [row] = await db
    .update(plugins)
    .set({
      trustStatus: input.trustStatus,
      riskLevel: input.riskLevel !== undefined ? input.riskLevel : existing[0].riskLevel,
      approvedScopes: input.approvedScopes ?? existing[0].approvedScopes,
      reviewedAt: new Date(),
      reviewedByUserId: input.reviewedByUserId,
      updatedAt: new Date(),
    })
    .where(eq(plugins.id, input.pluginId))
    .returning();

  return {
    id: row.id,
    type: "plugin",
    name: row.pluginKey,
    provider: row.packageName,
    version: row.version,
    versionHash: null,
    source: "plugin",
    sourceUrl: row.sourceUrl,
    trustStatus: row.trustStatus,
    riskLevel: row.riskLevel,
    requestedScopes: row.requestedScopes,
    approvedScopes: row.approvedScopes,
    signature: row.signature,
    signatureVerified: row.signatureVerified,
    enabled: row.status !== "disabled" && row.status !== "uninstalled",
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewedBy: row.reviewedByUserId,
    companyId: null,
    createdAt: row.installedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
