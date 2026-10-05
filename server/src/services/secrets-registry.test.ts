import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentApiKeys, agents, authUsers, boardApiKeys, companies, companySecrets, createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { getSecretsRegistryEntry, listSecretsRegistry } from "./secrets-registry.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secrets-registry integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-secrets-registry-");
  cleanups.push(testDb.cleanup);
  return createDb(testDb.connectionString);
}

async function seedUser(db: Db, name = "Test User") {
  const id = randomUUID();
  const now = new Date();
  await db.insert(authUsers).values({ id, name, email: `${id}@example.com`, createdAt: now, updatedAt: now });
  return id;
}

async function seedCompany(db: Db) {
  // issuePrefix has a unique constraint with the same default for every
  // row — must be overridden whenever a test seeds more than one company
  // in the same database.
  const [company] = await db
    .insert(companies)
    .values({ name: `Secrets Test Co ${randomUUID()}`, issuePrefix: randomUUID().slice(0, 8).toUpperCase() })
    .returning();
  return company;
}

async function seedAgent(db: Db, companyId: string) {
  const [agent] = await db.insert(agents).values({ companyId, name: "Test Agent" }).returning();
  return agent;
}

describeEmbeddedPostgres("F-02 secrets-registry (isolated test DB, no production credentials touched)", () => {
  it("[secret metadata] lists a company secret without ever including plaintext material or a decrypted value", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await db.insert(companySecrets).values({
      companyId: company.id,
      scope: "company",
      key: "OPENAI_API_KEY",
      name: "OpenAI API Key",
      provider: "local_encrypted",
      status: "active",
    });

    const entries = await listSecretsRegistry(db, { companyId: company.id, requestingUserId: "unused" });
    const secretEntries = entries.filter((e) => e.type === "secret");
    expect(secretEntries).toHaveLength(1);
    expect(secretEntries[0].label).toBe("OpenAI API Key");
    expect(secretEntries[0].maskedIdentifier).toBeNull();
    // No field anywhere on the projected entry could possibly carry
    // plaintext — structurally, since the service never selects
    // company_secret_versions.material at all.
    expect(JSON.stringify(secretEntries[0])).not.toMatch(/material/i);
  }, 30_000);

  it("[disabled item / deleted] a soft-deleted secret is excluded from listing", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    await db.insert(companySecrets).values({
      companyId: company.id, scope: "company", key: "DELETED_KEY", name: "Deleted", status: "deleted",
    });
    const entries = await listSecretsRegistry(db, { companyId: company.id, requestingUserId: "unused" });
    expect(entries.filter((e) => e.type === "secret")).toHaveLength(0);
  }, 30_000);

  it("[wrong company deny] a secret from a different company never appears in another company's listing", async () => {
    const db = await newTestDb();
    const companyA = await seedCompany(db);
    const companyB = await seedCompany(db);
    await db.insert(companySecrets).values({
      companyId: companyA.id, scope: "company", key: "A_ONLY_KEY", name: "Company A secret", status: "active",
    });
    const entriesForB = await listSecretsRegistry(db, { companyId: companyB.id, requestingUserId: "unused" });
    expect(entriesForB.filter((e) => e.type === "secret")).toHaveLength(0);
  }, 30_000);

  it("[revoked credential] an agent API key's revokedAt is reported as status=revoked", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    await db.insert(agentApiKeys).values({
      agentId: agent.id, companyId: company.id, name: "revoked-key", keyHash: "a".repeat(24),
      revokedAt: new Date(),
    });
    const entries = await listSecretsRegistry(db, { companyId: company.id, requestingUserId: "unused" });
    const key = entries.find((e) => e.type === "agent_api_key");
    expect(key?.status).toBe("revoked");
    expect(key?.maskedIdentifier).toMatch(/^hash:/);
    expect(key?.maskedIdentifier).not.toContain("a".repeat(24)); // never the raw hash
  }, 30_000);

  it("[expired credential] a board API key past its expiresAt is reported as status=expired, not active", async () => {
    const db = await newTestDb();
    const userId = await seedUser(db);
    await db.insert(boardApiKeys).values({
      userId, name: "expired-key", keyHash: "b".repeat(24),
      expiresAt: new Date(Date.now() - 1000 * 60), // 1 minute ago
    });
    const entries = await listSecretsRegistry(db, { companyId: randomUUID(), requestingUserId: userId });
    const key = entries.find((e) => e.type === "board_api_key");
    expect(key?.status).toBe("expired");
  }, 30_000);

  it("[active credential] a board API key with no revokedAt and a future/absent expiresAt is active", async () => {
    const db = await newTestDb();
    const userId = await seedUser(db);
    await db.insert(boardApiKeys).values({ userId, name: "active-key", keyHash: "c".repeat(24) });
    const entries = await listSecretsRegistry(db, { companyId: randomUUID(), requestingUserId: userId });
    const key = entries.find((e) => e.type === "board_api_key");
    expect(key?.status).toBe("active");
  }, 30_000);

  it("[wrong agent/user deny] board API keys are scoped ONLY to the requesting user — another user's keys never appear", async () => {
    const db = await newTestDb();
    const userA = await seedUser(db, "User A");
    const userB = await seedUser(db, "User B");
    await db.insert(boardApiKeys).values({ userId: userA, name: "user-a-key", keyHash: "d".repeat(24) });
    await db.insert(boardApiKeys).values({ userId: userB, name: "user-b-key", keyHash: "e".repeat(24) });

    const entriesForA = await listSecretsRegistry(db, { companyId: randomUUID(), requestingUserId: userA });
    const boardKeysForA = entriesForA.filter((e) => e.type === "board_api_key");
    expect(boardKeysForA).toHaveLength(1);
    expect(boardKeysForA[0].label).toBe("user-a-key");
  }, 30_000);

  it("[malformed/unknown id] getSecretsRegistryEntry returns null for a non-existent id rather than throwing", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const result = await getSecretsRegistryEntry(db, randomUUID(), { companyId: company.id, requestingUserId: "unused" });
    expect(result).toBeNull();
  }, 30_000);

  it("[scope filter] the type query filters correctly across all three source tables", async () => {
    const db = await newTestDb();
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const userId = await seedUser(db);
    await db.insert(companySecrets).values({ companyId: company.id, scope: "company", key: "K", name: "K", status: "active" });
    await db.insert(agentApiKeys).values({ agentId: agent.id, companyId: company.id, name: "ak", keyHash: "f".repeat(24) });
    await db.insert(boardApiKeys).values({ userId, name: "bk", keyHash: "g".repeat(24) });

    const all = await listSecretsRegistry(db, { companyId: company.id, requestingUserId: userId });
    expect(all).toHaveLength(3);

    const onlySecrets = await listSecretsRegistry(db, { companyId: company.id, requestingUserId: userId, type: "secret" });
    expect(onlySecrets.every((e) => e.type === "secret")).toBe(true);
    expect(onlySecrets).toHaveLength(1);
  }, 30_000);
});

describe("F-02 static safety guards (source-level, no DB required)", () => {
  it(
    "[plaintext log leak test] the new registry service/route never logs, and never selects, " +
      "company_secret_versions.material or a raw keyHash column",
    () => {
      const files = [
        path.join(import.meta.dirname, "secrets-registry.ts"),
        path.join(import.meta.dirname, "secret-masking.ts"),
        path.join(import.meta.dirname, "..", "routes", "secrets-registry.ts"),
      ];
      for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        // No logger/console call anywhere in these files at all — a
        // read-only projection has no legitimate reason to log per-row
        // data, so the simplest, strongest guard is that no logging call
        // exists here in the first place.
        expect(/logger\.(info|warn|error|debug)\(|console\.(log|warn|error)\(/.test(source), file).toBe(false);
        // The encrypted payload table is never imported/selected — the
        // service has no code path capable of reaching plaintext material.
        expect(source.includes("companySecretVersions"), file).toBe(false);
        // row.keyHash may only ever appear wrapped in maskFromHash(...) —
        // never assigned/returned raw (e.g. `keyHash: row.keyHash`).
        if (!file.endsWith("secret-masking.ts") && source.includes("row.keyHash")) {
          expect(/keyHash:\s*row\.keyHash\b/.test(source), file).toBe(false);
          expect(source.includes("maskFromHash(row.keyHash)"), file).toBe(true);
        }
      }
    },
  );

  it("[Human Approval Gate regression] the new files never reference the approvals table or bypass secret-proposal review", () => {
    const files = [
      path.join(import.meta.dirname, "secrets-registry.ts"),
      path.join(import.meta.dirname, "..", "routes", "secrets-registry.ts"),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source.includes("approvals"), file).toBe(false);
      // Actual Drizzle mutation calls only — not incidental substrings like
      // "updatedAt" or "deleted" (a filter value, not a mutation).
      expect(/\.(insert|update|delete)\(/.test(source), file).toBe(false);
    }
  });
});
