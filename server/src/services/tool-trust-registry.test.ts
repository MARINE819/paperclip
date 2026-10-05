import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, companies, plugins, toolApplications, toolCatalogEntries, toolConnections, toolPolicies } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { getTrustRegistryEntry, listTrustRegistry, PluginNotFoundError, reviewPluginTrust } from "./tool-trust-registry.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping tool-trust-registry integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-trust-");
  cleanups.push(testDb.cleanup);
  return createDb(testDb.connectionString);
}

async function seedCompany(db: Db) {
  const [company] = await db.insert(companies).values({ name: `Trust Test Co ${randomUUID()}` }).returning();
  return company;
}

async function seedApplication(db: Db, companyId: string, name = "Test App") {
  const [app] = await db
    .insert(toolApplications)
    .values({ companyId, name, type: "mcp_http" })
    .returning();
  return app;
}

async function seedConnection(
  db: Db,
  companyId: string,
  applicationId: string,
  transport: "mcp_remote" | "rest_api" | "local_stdio" = "mcp_remote",
  enabled = true,
) {
  const [conn] = await db
    .insert(toolConnections)
    .values({
      companyId,
      applicationId,
      name: "Test Connection",
      uid: `conn-${randomUUID()}`,
      transport,
      enabled,
    })
    .returning();
  return conn;
}

async function seedCatalogEntry(
  db: Db,
  companyId: string,
  connectionId: string,
  overrides: Partial<{ name: string; toolName: string; versionHash: string; status: string; riskLevel: string }> = {},
) {
  const [entry] = await db
    .insert(toolCatalogEntries)
    .values({
      companyId,
      connectionId,
      name: overrides.name ?? `tool-${randomUUID()}`,
      toolName: overrides.toolName ?? "do_thing",
      versionHash: overrides.versionHash ?? "hash-v1",
      status: (overrides.status as never) ?? "active",
      riskLevel: (overrides.riskLevel as never) ?? "read",
    })
    .returning();
  return entry;
}

describeEmbeddedPostgres("F-05 tool-trust-registry (isolated test DB, no production data touched)", () => {
  it("[unreviewed default] a tool catalog entry with no matching policy is unreviewed", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const app = await seedApplication(db, company.id);
    const conn = await seedConnection(db, company.id, app.id);
    const catalogEntry = await seedCatalogEntry(db, company.id, conn.id);

    const found = await getTrustRegistryEntry(db, catalogEntry.id);
    expect(found).not.toBeNull();
    expect(found?.trustStatus).toBe("unreviewed");
    expect(found?.type).toBe("mcp"); // transport mcp_remote
    expect(found?.provider).toBe("Test App");
  }, 30_000);

  it("[trusted tool] an enabled trust_rule policy matching the catalog entry derives trustStatus=trusted", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const app = await seedApplication(db, company.id);
    const conn = await seedConnection(db, company.id, app.id, "rest_api");
    const catalogEntry = await seedCatalogEntry(db, company.id, conn.id);

    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: `trust-rule-${randomUUID()}`,
      policyType: "trust_rule",
      enabled: true,
      selectors: { catalogEntryId: catalogEntry.id },
      config: { trustRule: {} },
    });

    const found = await getTrustRegistryEntry(db, catalogEntry.id);
    expect(found?.trustStatus).toBe("trusted");
    expect(found?.type).toBe("tool"); // transport rest_api, not mcp
  }, 30_000);

  it("[revoked tool] a trust_rule with revokedAt set derives trustStatus=revoked, not trusted", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const app = await seedApplication(db, company.id);
    const conn = await seedConnection(db, company.id, app.id);
    const catalogEntry = await seedCatalogEntry(db, company.id, conn.id);

    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: `trust-rule-${randomUUID()}`,
      policyType: "trust_rule",
      enabled: true,
      selectors: { catalogEntryId: catalogEntry.id },
      config: { trustRule: { revokedAt: new Date().toISOString() } },
    });

    const found = await getTrustRegistryEntry(db, catalogEntry.id);
    expect(found?.trustStatus).toBe("revoked");
  }, 30_000);

  it("[blocked tool] an enabled block policy matching the catalog entry derives trustStatus=blocked", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const app = await seedApplication(db, company.id);
    const conn = await seedConnection(db, company.id, app.id);
    const catalogEntry = await seedCatalogEntry(db, company.id, conn.id);

    await db.insert(toolPolicies).values({
      companyId: company.id,
      name: `block-${randomUUID()}`,
      policyType: "block",
      enabled: true,
      selectors: { catalogEntryId: catalogEntry.id },
    });

    const found = await getTrustRegistryEntry(db, catalogEntry.id);
    expect(found?.trustStatus).toBe("blocked");
  }, 30_000);

  it("[blocked tool] a quarantined catalog entry derives trustStatus=blocked even with no policy at all", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const app = await seedApplication(db, company.id);
    const conn = await seedConnection(db, company.id, app.id);
    const catalogEntry = await seedCatalogEntry(db, company.id, conn.id, { status: "quarantined" });

    const found = await getTrustRegistryEntry(db, catalogEntry.id);
    expect(found?.trustStatus).toBe("blocked");
  }, 30_000);

  it("[disabled item] a catalog entry on a disabled connection reports enabled=false", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const app = await seedApplication(db, company.id);
    const conn = await seedConnection(db, company.id, app.id, "mcp_remote", false);
    const catalogEntry = await seedCatalogEntry(db, company.id, conn.id);

    const found = await getTrustRegistryEntry(db, catalogEntry.id);
    expect(found?.enabled).toBe(false);
  }, 30_000);

  it("[duplicate registry item] a catalog entry with MULTIPLE matching policies still appears exactly once", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const app = await seedApplication(db, company.id);
    const conn = await seedConnection(db, company.id, app.id);
    const catalogEntry = await seedCatalogEntry(db, company.id, conn.id);

    // Two distinct enabled policies both targeting the same entry.
    await db.insert(toolPolicies).values({
      companyId: company.id, name: `trust-rule-a-${randomUUID()}`, policyType: "trust_rule",
      enabled: true, selectors: { catalogEntryId: catalogEntry.id }, config: { trustRule: {} },
    });
    await db.insert(toolPolicies).values({
      companyId: company.id, name: `trust-rule-b-${randomUUID()}`, policyType: "trust_rule",
      enabled: true, selectors: { catalogEntryId: catalogEntry.id }, config: { trustRule: {} },
    });

    const all = await listTrustRegistry(db);
    const matches = all.filter((e) => e.id === catalogEntry.id);
    expect(matches).toHaveLength(1);
  }, 30_000);

  it("[auth-independent unit] filters (type/trustStatus/enabled) narrow listTrustRegistry correctly", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const app = await seedApplication(db, company.id);
    const mcpConn = await seedConnection(db, company.id, app.id, "mcp_remote");
    const restConn = await seedConnection(db, company.id, app.id, "rest_api");
    await seedCatalogEntry(db, company.id, mcpConn.id);
    await seedCatalogEntry(db, company.id, restConn.id);

    const mcpOnly = await listTrustRegistry(db, { type: "mcp" });
    expect(mcpOnly.every((e) => e.type === "mcp")).toBe(true);
    expect(mcpOnly.length).toBeGreaterThan(0);

    const unreviewedOnly = await listTrustRegistry(db, { trustStatus: "unreviewed" });
    expect(unreviewedOnly.every((e) => e.trustStatus === "unreviewed")).toBe(true);
  }, 30_000);

  it("[plugin trust] a fresh plugin defaults to unreviewed, and reviewPluginTrust is the only way to change it", async () => {
    const db = await newTestDb();
    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey: `plugin-${randomUUID()}`,
        packageName: "@test/plugin",
        version: "1.0.0",
        manifestJson: {} as never,
      })
      .returning();

    const before = await getTrustRegistryEntry(db, plugin.id);
    expect(before?.trustStatus).toBe("unreviewed");
    expect(before?.type).toBe("plugin");
    expect(before?.provider).toBe("@test/plugin");

    const reviewed = await reviewPluginTrust(db, {
      pluginId: plugin.id,
      trustStatus: "trusted",
      riskLevel: "low",
      approvedScopes: ["read:files"],
      reviewedByUserId: "human-admin-1",
    });
    expect(reviewed.trustStatus).toBe("trusted");
    expect(reviewed.reviewedBy).toBe("human-admin-1");
    expect(reviewed.approvedScopes).toEqual(["read:files"]);

    const after = await getTrustRegistryEntry(db, plugin.id);
    expect(after?.trustStatus).toBe("trusted");
  }, 30_000);

  it("[plugin trust][malformed input] reviewing a non-existent plugin fails closed with a typed error", async () => {
    const db = await newTestDb();
    await expect(
      reviewPluginTrust(db, {
        pluginId: randomUUID(),
        trustStatus: "trusted",
        reviewedByUserId: "human-admin-1",
      }),
    ).rejects.toBeInstanceOf(PluginNotFoundError);
  }, 30_000);

  it("[plugin trust][blocked/revoked] a plugin can be set to blocked and to revoked via the review path", async () => {
    const db = await newTestDb();
    const [plugin] = await db
      .insert(plugins)
      .values({ pluginKey: `plugin-${randomUUID()}`, packageName: "@test/plugin2", version: "1.0.0", manifestJson: {} as never })
      .returning();

    const blocked = await reviewPluginTrust(db, { pluginId: plugin.id, trustStatus: "blocked", reviewedByUserId: "admin" });
    expect(blocked.trustStatus).toBe("blocked");

    const revoked = await reviewPluginTrust(db, { pluginId: plugin.id, trustStatus: "revoked", reviewedByUserId: "admin" });
    expect(revoked.trustStatus).toBe("revoked");
  }, 30_000);
});
