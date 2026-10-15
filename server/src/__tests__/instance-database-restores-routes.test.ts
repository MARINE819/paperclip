import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import {
  instanceDatabaseRestoreCatalogRoutes,
  type InstanceDatabaseRestoreCatalogService,
} from "../routes/instance-database-restores.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function createTempBackupDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-server-restore-catalog-"));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function createApp(actor: Record<string, unknown>, service: InstanceDatabaseRestoreCatalogService) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", instanceDatabaseRestoreCatalogRoutes(service));
  app.use(errorHandler);
  return app;
}

function writeValidBackupWithManifest(backupDir: string, name: string): { sha256: string; sizeBytes: number } {
  const backupFile = path.join(backupDir, name);
  const content = `fake backup content for ${name}`;
  fs.writeFileSync(backupFile, content, "utf8");
  const sizeBytes = fs.statSync(backupFile).size;
  const sha256 = createHash("sha256").update(fs.readFileSync(backupFile)).digest("hex");
  const manifest = {
    version: 1,
    backupFile: name,
    sha256,
    sizeBytes,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${backupFile}.manifest.json`, JSON.stringify(manifest), "utf8");
  return { sha256, sizeBytes };
}

const adminActor = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true };
const nonAdminActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
};

describe("instance database restore catalog routes", () => {
  it("returns the catalog for an instance admin", async () => {
    const backupDir = createTempBackupDir();
    writeValidBackupWithManifest(backupDir, "paperclip-20260101-000000.sql.gz");

    const res = await request(createApp(adminActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    expect(res.status).toBe(200);
    expect(res.body.backups).toHaveLength(1);
    expect(res.body.backups[0].manifestStatus).toBe("valid");
  });

  it("rejects a non-admin board user", async () => {
    const backupDir = createTempBackupDir();

    const res = await request(createApp(nonAdminActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    expect(res.status).toBe(403);
  });

  it("rejects agent callers", async () => {
    const backupDir = createTempBackupDir();
    const agentActor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" };

    const res = await request(createApp(agentActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    expect(res.status).toBe(403);
  });

  describe("cloud-managed floor", () => {
    it("floors the catalog off for every instance admin on a cloud-managed instance", async () => {
      process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
      try {
        const backupDir = createTempBackupDir();
        const res = await request(createApp(adminActor, { backupDir })).get(
          "/api/instance/database-restores/catalog",
        );
        expect(res.status).toBe(403);
        expect(res.body.details).toMatchObject({ code: "database_restores_platform_managed" });
      } finally {
        delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      }
    });
  });

  it("reports manifestStatus=valid with manifestSha256 for a correctly manifested backup", async () => {
    const backupDir = createTempBackupDir();
    const { sha256 } = writeValidBackupWithManifest(backupDir, "paperclip-valid.sql.gz");

    const res = await request(createApp(adminActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    expect(res.body.backups).toEqual([
      expect.objectContaining({
        backupId: "paperclip-valid.sql.gz",
        manifestStatus: "valid",
        manifestSha256: sha256,
      }),
    ]);
  });

  it("reports manifestStatus=missing when no manifest sidecar exists", async () => {
    const backupDir = createTempBackupDir();
    fs.writeFileSync(path.join(backupDir, "paperclip-no-manifest.sql.gz"), "content", "utf8");

    const res = await request(createApp(adminActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    expect(res.body.backups).toEqual([
      expect.objectContaining({ backupId: "paperclip-no-manifest.sql.gz", manifestStatus: "missing" }),
    ]);
    expect(res.body.backups[0].manifestSha256).toBeUndefined();
  });

  it("reports manifestStatus=malformed when the manifest sidecar is not valid JSON", async () => {
    const backupDir = createTempBackupDir();
    const backupFile = path.join(backupDir, "paperclip-malformed.sql.gz");
    fs.writeFileSync(backupFile, "content", "utf8");
    fs.writeFileSync(`${backupFile}.manifest.json`, "{not valid json", "utf8");

    const res = await request(createApp(adminActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    expect(res.body.backups).toEqual([
      expect.objectContaining({ backupId: "paperclip-malformed.sql.gz", manifestStatus: "malformed" }),
    ]);
  });

  it("reports manifestStatus=hash_mismatch when the manifest sha256 does not match the backup file", async () => {
    const backupDir = createTempBackupDir();
    const name = "paperclip-hash-mismatch.sql.gz";
    writeValidBackupWithManifest(backupDir, name);
    const manifestPath = path.join(backupDir, `${name}.manifest.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.sha256 = "0".repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const res = await request(createApp(adminActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    expect(res.body.backups).toEqual([
      expect.objectContaining({ backupId: name, manifestStatus: "hash_mismatch" }),
    ]);
  });

  it("returns an empty list for an empty backup directory", async () => {
    const backupDir = createTempBackupDir();

    const res = await request(createApp(adminActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    expect(res.status).toBe(200);
    expect(res.body.backups).toEqual([]);
  });

  it("returns an empty list (not an error) when the backup directory does not exist", async () => {
    const backupDir = path.join(os.tmpdir(), "paperclip-restore-catalog-does-not-exist-" + Date.now());

    const res = await request(createApp(adminActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    expect(res.status).toBe(200);
    expect(res.body.backups).toEqual([]);
  });

  it("sorts results newest-created first", async () => {
    const backupDir = createTempBackupDir();
    writeValidBackupWithManifest(backupDir, "paperclip-older.sql.gz");
    fs.utimesSync(
      path.join(backupDir, "paperclip-older.sql.gz"),
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
    writeValidBackupWithManifest(backupDir, "paperclip-newer.sql.gz");
    fs.utimesSync(
      path.join(backupDir, "paperclip-newer.sql.gz"),
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-01T00:00:00Z"),
    );

    const res = await request(createApp(adminActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    expect(res.body.backups.map((b: { backupId: string }) => b.backupId)).toEqual([
      "paperclip-newer.sql.gz",
      "paperclip-older.sql.gz",
    ]);
  });

  it("never includes the absolute backup directory path or any absolute path in the response", async () => {
    const backupDir = createTempBackupDir();
    writeValidBackupWithManifest(backupDir, "paperclip-path-check.sql.gz");

    const res = await request(createApp(adminActor, { backupDir })).get(
      "/api/instance/database-restores/catalog",
    );

    const serialized = JSON.stringify(res.body);
    expect(serialized.includes(backupDir)).toBe(false);
    for (const entry of res.body.backups) {
      expect(entry.backupId.includes("/")).toBe(false);
      expect(entry.backupId.includes("\\")).toBe(false);
    }
  });

  it("does not create, modify, or delete any file in the backup directory", async () => {
    const backupDir = createTempBackupDir();
    writeValidBackupWithManifest(backupDir, "paperclip-untouched.sql.gz");
    const before = fs.readdirSync(backupDir).sort();

    await request(createApp(adminActor, { backupDir })).get("/api/instance/database-restores/catalog");

    const after = fs.readdirSync(backupDir).sort();
    expect(after).toEqual(before);
  });
});
