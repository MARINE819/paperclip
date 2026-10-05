import {
  boolean,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  PluginCategory,
  PluginStatus,
  PaperclipPluginManifestV1,
  ToolRiskLevel,
  ToolTrustStatus,
} from "@paperclipai/shared";

/**
 * `plugins` table — stores one row per installed plugin.
 *
 * Each plugin is uniquely identified by `plugin_key` (derived from
 * the manifest `id`). The full manifest is persisted as JSONB in
 * `manifest_json` so the host can reconstruct capability and UI
 * slot information without loading the plugin package.
 *
 * @see PLUGIN_SPEC.md §21.3
 */
export const plugins = pgTable(
  "plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginKey: text("plugin_key").notNull(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    apiVersion: integer("api_version").notNull().default(1),
    categories: jsonb("categories").$type<PluginCategory[]>().notNull().default([]),
    manifestJson: jsonb("manifest_json").$type<PaperclipPluginManifestV1>().notNull(),
    status: text("status").$type<PluginStatus>().notNull().default("installed"),
    installOrder: integer("install_order"),
    /** Resolved package path for local-path installs; used to find worker entrypoint. */
    packagePath: text("package_path"),
    lastError: text("last_error"),
    // F-05 Trust Registry additions. Unlike tools (which derive trust from
    // the existing tool_policies engine), plugins had no trust concept at
    // all before this — these are genuinely new storage, not a duplicate of
    // anything. `trustStatus` defaults to "unreviewed" and can only ever be
    // advanced by an explicit admin write (see
    // server/src/services/tool-trust-registry.ts) — there is deliberately
    // no `reviewedByAgentId` column: an agent can never be recorded as the
    // reviewer of its own or any plugin's trust status.
    riskLevel: text("risk_level").$type<ToolRiskLevel>(),
    trustStatus: text("trust_status").$type<ToolTrustStatus>().notNull().default("unreviewed"),
    requestedScopes: jsonb("requested_scopes").$type<string[]>().notNull().default([]),
    approvedScopes: jsonb("approved_scopes").$type<string[]>().notNull().default([]),
    signature: text("signature"),
    signatureVerified: boolean("signature_verified").notNull().default(false),
    sourceUrl: text("source_url"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: text("reviewed_by_user_id"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginKeyIdx: uniqueIndex("plugins_plugin_key_idx").on(table.pluginKey),
    statusIdx: index("plugins_status_idx").on(table.status),
    trustStatusIdx: index("plugins_trust_status_idx").on(table.trustStatus),
  }),
);
