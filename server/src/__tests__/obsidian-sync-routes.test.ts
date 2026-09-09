import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  issues,
  knowledgeRecords,
  memoryOperations,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { knowledgeRoutes } from "../routes/knowledge.js";
import {
  resolveVaultRelativePath,
  sanitizeObsidianSyncError,
  vaultRelativePathForKnowledgeRecord,
} from "../services/obsidian-sync.js";
import {
  describeEmbeddedPostgres,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

/**
 * Phase 2.2 integration coverage for one-way Knowledge Record -> Obsidian
 * Markdown sync. Every test uses a throwaway temp directory as the vault
 * root (never a real/live vault) and the same isolated embedded Postgres
 * instance as the Phase 2.1 suite (never the live DB).
 */

type AgentActor = {
  type: "agent";
  agentId: string;
  companyId: string;
  runId: string | null;
  keyId: string | null;
  source: "agent_key";
};

function buildApp(db: Db, actor: BoardActor | AgentActor, vaultRoot: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", knowledgeRoutes(db, { obsidianVaultRoot: vaultRoot }));
  app.use(errorHandler);
  return app;
}

async function resetFixtures(db: Db) {
  await db.delete(activityLog);
  await db.delete(knowledgeRecords);
  await db.delete(memoryOperations);
  await db.delete(issues);
  await db.delete(agents);
  await db.delete(principalPermissionGrants);
  await db.delete(companyMemberships);
  await db.delete(companies);
}

async function mkVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "paperclip-obsidian-vault-"));
}

async function rmDir(dir: string | null | undefined) {
  if (!dir) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function insertApprovedKnowledgeCandidate(
  db: Db,
  companyId: string,
  overrides: Partial<{ title: string; summary: string | null; body: string }> = {},
) {
  const [op] = await db.insert(memoryOperations).values({
    companyId,
    sourceType: "issue",
    sourceId: "issue-ref",
    content: overrides.body ?? "## Root cause\nRetried twice by mistake.",
    status: "candidate",
    reviewState: "approved",
    title: overrides.title ?? "Sync target",
  }).returning();
  const [record] = await db.insert(knowledgeRecords).values({
    companyId,
    title: overrides.title ?? "Sync target",
    summary: overrides.summary === undefined ? "One line summary" : overrides.summary,
    body: overrides.body ?? "## Root cause\nRetried twice by mistake.",
    sourceMemoryOperationId: op.id,
  }).returning();
  return record;
}

async function symlinkSupported(vaultRoot: string): Promise<boolean> {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-obsidian-symlink-probe-"));
  const linkPath = path.join(vaultRoot, `probe-${randomUUID()}`);
  try {
    await fs.symlink(outside, linkPath, "dir");
    await fs.unlink(linkPath);
    return true;
  } catch {
    return false;
  } finally {
    await rmDir(outside);
  }
}

describe("resolveVaultRelativePath (pure path-safety unit coverage)", () => {
  let vaultRoot = "";

  afterEach(async () => {
    await rmDir(vaultRoot);
    vaultRoot = "";
  });

  async function freshVault() {
    vaultRoot = await mkVault();
    return vaultRoot;
  }

  it("resolves a normal relative path inside the vault", async () => {
    const root = await freshVault();
    const { absolutePath } = await resolveVaultRelativePath(root, "knowledge/note.md");
    expect(absolutePath.startsWith(await fs.realpath(root))).toBe(true);
  });

  it("rejects '../' traversal", async () => {
    const root = await freshVault();
    await expect(resolveVaultRelativePath(root, "../escape.md")).rejects.toThrow();
    await expect(resolveVaultRelativePath(root, "knowledge/../../escape.md")).rejects.toThrow();
  });

  it("rejects absolute POSIX paths", async () => {
    const root = await freshVault();
    await expect(resolveVaultRelativePath(root, "/etc/passwd")).rejects.toThrow();
  });

  it("rejects Windows drive-letter paths (absolute and drive-relative)", async () => {
    const root = await freshVault();
    await expect(resolveVaultRelativePath(root, "C:\\Windows\\note.md")).rejects.toThrow();
    await expect(resolveVaultRelativePath(root, "C:note.md")).rejects.toThrow();
  });

  it("rejects UNC paths", async () => {
    const root = await freshVault();
    await expect(resolveVaultRelativePath(root, "\\\\server\\share\\note.md")).rejects.toThrow();
    await expect(resolveVaultRelativePath(root, "//server/share/note.md")).rejects.toThrow();
  });

  it("rejects a symlinked directory that escapes the vault root, when the host supports symlinks", async () => {
    const root = await freshVault();
    if (!(await symlinkSupported(root))) {
      console.warn("Skipping symlink-escape assertion: this host cannot create symlinks (no privilege).");
      return;
    }
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-obsidian-outside-"));
    try {
      await fs.symlink(outside, path.join(root, "escape-link"), "dir");
      await expect(resolveVaultRelativePath(root, "escape-link/note.md")).rejects.toThrow();
      const leaked = await fs.readdir(outside);
      expect(leaked).toHaveLength(0);
    } finally {
      await rmDir(outside);
    }
  });

  it("never echoes an absolute filesystem path in a sanitized error", async () => {
    const root = await freshVault();
    try {
      await resolveVaultRelativePath(root, "../escape.md");
      throw new Error("expected resolveVaultRelativePath to reject");
    } catch (error) {
      const message = sanitizeObsidianSyncError(error);
      expect(message).not.toContain(root);
      expect(message.toLowerCase()).not.toContain(os.tmpdir().toLowerCase());
    }
  });
});

describeEmbeddedPostgres("obsidian sync routes (knowledge record -> markdown file)", () => {
  const ctx = useEmbeddedPostgres("paperclip-obsidian-sync-routes-", { resetEach: resetFixtures });
  let vaultRoot = "";

  afterEach(async () => {
    await rmDir(vaultRoot);
    vaultRoot = "";
  });

  async function freshVault() {
    vaultRoot = await mkVault();
    return vaultRoot;
  }

  it("lets the board sync a knowledge record to a markdown file and records success", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Vault Co");
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId);

    const res = await request(buildApp(ctx.db, company.actor, root))
      .post(`/api/knowledge-records/${record.id}/obsidian-sync`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      obsidianSyncState: "synced",
      obsidianSyncError: null,
    });
    expect(res.body.obsidianPath).toBeTruthy();
    expect(res.body.obsidianSyncedAt).toBeTruthy();

    const filePath = path.join(root, res.body.obsidianPath);
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain(record.body);
  });

  it("returns 403 for an agent actor and changes neither the DB row nor the filesystem", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Vault Co");
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId);
    const agentActor: AgentActor = {
      type: "agent",
      agentId: randomUUID(),
      companyId: company.companyId,
      runId: null,
      keyId: null,
      source: "agent_key",
    };

    const res = await request(buildApp(ctx.db, agentActor, root))
      .post(`/api/knowledge-records/${record.id}/obsidian-sync`)
      .send({});

    expect(res.status).toBe(403);
    const [unchanged] = await ctx.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, record.id));
    expect(unchanged).toMatchObject({ obsidianSyncState: "pending", obsidianPath: null });
    const entries = await fs.readdir(root).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it("blocks another company's board actor from syncing the record", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Vault Co");
    const otherCompany = await seedCompanyWithBoardAccess(ctx.db, "Other Co");
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId);

    const res = await request(buildApp(ctx.db, otherCompany.actor, root))
      .post(`/api/knowledge-records/${record.id}/obsidian-sync`)
      .send({});

    expect(res.status).toBe(404);
    const entries = await fs.readdir(root).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  it("preserves the markdown body verbatim and represents title/summary safely", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Vault Co");
    const trickyTitle = 'Weird: "title"\n---\nfoo: bar';
    const trickySummary = "Line one\nLine two: still one field";
    const body = "# Heading\n\n---\n\nA horizontal rule inside the body must survive untouched.";
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId, {
      title: trickyTitle,
      summary: trickySummary,
      body,
    });

    const res = await request(buildApp(ctx.db, company.actor, root))
      .post(`/api/knowledge-records/${record.id}/obsidian-sync`)
      .send({});
    expect(res.status).toBe(200);

    const filePath = path.join(root, res.body.obsidianPath);
    const content = await fs.readFile(filePath, "utf8");

    // Body must appear byte-for-byte, unmodified, after the frontmatter block.
    expect(content.endsWith(body)).toBe(true);
    expect(content.startsWith("---\n")).toBe(true);

    // Frontmatter must parse as well-formed YAML with no injected keys: the
    // block between the first two '---' lines is exactly 4 lines (id,
    // companyId, title, summary), not more.
    const closeIndex = content.indexOf("\n---\n", 4);
    const frontmatterBlock = content.slice(4, closeIndex);
    const frontmatterLines = frontmatterBlock.split("\n");
    expect(frontmatterLines).toHaveLength(4);
    expect(frontmatterLines.some((line) => line.startsWith("foo:"))).toBe(false);
    expect(frontmatterLines.find((line) => line.startsWith("title:"))).toBe(
      `title: ${JSON.stringify(trickyTitle)}`,
    );
    expect(frontmatterLines.find((line) => line.startsWith("summary:"))).toBe(
      `summary: ${JSON.stringify(trickySummary)}`,
    );
  });

  it("updates the success status columns and keeps the same path on re-sync (idempotent)", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Vault Co");
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId);
    const app = buildApp(ctx.db, company.actor, root);

    const first = await request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({});
    expect(first.status).toBe(200);
    const firstPath = first.body.obsidianPath as string;
    const firstSyncedAt = first.body.obsidianSyncedAt as string;

    const second = await request(app).post(`/api/knowledge-records/${record.id}/obsidian-sync`).send({});
    expect(second.status).toBe(200);
    expect(second.body.obsidianPath).toBe(firstPath);
    expect(second.body.obsidianSyncState).toBe("synced");
    expect(new Date(second.body.obsidianSyncedAt).getTime())
      .toBeGreaterThanOrEqual(new Date(firstSyncedAt).getTime());

    // Only one file exists on disk for this record; the vault has exactly
    // the one "knowledge" subdirectory with exactly the one file in it.
    const knowledgeDir = path.join(root, "knowledge");
    const files = await fs.readdir(knowledgeDir);
    expect(files).toHaveLength(1);
    // No leftover temp files anywhere under the vault.
    const tempFiles = files.filter((name) => name.includes(".tmp"));
    expect(tempFiles).toHaveLength(0);

    const logged = await ctx.db.select().from(activityLog)
      .where(eq(activityLog.action, "knowledge_record.obsidian_synced"));
    expect(logged.length).toBe(2); // two genuinely successful sync calls, each logged once
  });

  it("logs the mutation exactly once for a single successful sync call", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Vault Co");
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId);

    const res = await request(buildApp(ctx.db, company.actor, root))
      .post(`/api/knowledge-records/${record.id}/obsidian-sync`)
      .send({});
    expect(res.status).toBe(200);

    const logged = await ctx.db.select().from(activityLog)
      .where(eq(activityLog.action, "knowledge_record.obsidian_synced"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ entityType: "knowledge_record", entityId: record.id });
  });

  it("records a failed state without touching an already-synced, unrelated file, and does not leak host paths", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Vault Co");

    // Record A: sync it for real first, so a genuinely good file exists.
    const goodRecord = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId, { title: "Good record" });
    const app = buildApp(ctx.db, company.actor, root);
    const goodRes = await request(app).post(`/api/knowledge-records/${goodRecord.id}/obsidian-sync`).send({});
    expect(goodRes.status).toBe(200);
    const goodFilePath = path.join(root, goodRes.body.obsidianPath);
    const goodContentBefore = await fs.readFile(goodFilePath, "utf8");

    // Record B: force its target parent path to collide with a plain file,
    // so the write can never succeed (portable across OSes: mkdir over an
    // existing non-directory always fails).
    const blockedParent = path.join(root, "blocked-parent");
    await fs.writeFile(blockedParent, "not a directory");
    const badRecord = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId, { title: "Bad record" });
    await ctx.db.update(knowledgeRecords)
      .set({ obsidianPath: "blocked-parent/note.md" })
      .where(eq(knowledgeRecords.id, badRecord.id));

    const badRes = await request(app).post(`/api/knowledge-records/${badRecord.id}/obsidian-sync`).send({});

    expect(badRes.status).toBe(200);
    expect(badRes.body.obsidianSyncState).toBe("failed");
    expect(typeof badRes.body.obsidianSyncError).toBe("string");
    expect(badRes.body.obsidianSyncError).not.toContain(root);
    expect(badRes.body.obsidianSyncError.toLowerCase()).not.toContain(os.tmpdir().toLowerCase());

    // The unrelated, already-good file must be completely untouched.
    const goodContentAfter = await fs.readFile(goodFilePath, "utf8");
    expect(goodContentAfter).toBe(goodContentBefore);

    // No activity log entry for the failed attempt.
    const logged = await ctx.db.select().from(activityLog)
      .where(eq(activityLog.action, "knowledge_record.obsidian_synced"));
    expect(logged).toHaveLength(1); // only the earlier successful sync for the good record
  });

  it("cleans up its temp file when the final rename fails, and reports a failed state", async () => {
    const root = await freshVault();
    const company = await seedCompanyWithBoardAccess(ctx.db, "Vault Co");
    const record = await insertApprovedKnowledgeCandidate(ctx.db, company.companyId);

    // Pre-compute the record's own deterministic target path and pre-create
    // it as a directory, so the atomic rename-into-place step fails
    // (renaming a file onto an existing directory fails on every OS).
    const relativePath = vaultRelativePathForKnowledgeRecord(record);
    const targetDir = path.join(root, relativePath);
    await fs.mkdir(targetDir, { recursive: true });

    const res = await request(buildApp(ctx.db, company.actor, root))
      .post(`/api/knowledge-records/${record.id}/obsidian-sync`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.obsidianSyncState).toBe("failed");

    const parentDir = path.dirname(targetDir);
    const siblingEntries = await fs.readdir(parentDir);
    const tempLeftovers = siblingEntries.filter((name) => name.includes(".tmp"));
    expect(tempLeftovers).toHaveLength(0);

    // The directory that blocked the rename must still be there, untouched.
    const stat = await fs.stat(targetDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
