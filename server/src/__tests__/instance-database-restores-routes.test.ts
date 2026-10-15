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
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

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

function createTempHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-server-restore-jobs-home-"));
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

describe("POST /instance/database-restores/jobs", () => {
  function activeJobFilePath(homeDir: string): string {
    return path.join(resolvePaperclipInstanceRoot({ homeDir }), "restore-jobs", "active-job.json");
  }

  it("accepts a valid backupId for an instance admin and returns 202 with a job id", async () => {
    const backupDir = createTempBackupDir();
    const homeDir = createTempHomeDir();
    writeValidBackupWithManifest(backupDir, "paperclip-accept.sql.gz");

    const res = await request(createApp(adminActor, { backupDir, homeDir }))
      .post("/api/instance/database-restores/jobs")
      .send({ backupId: "paperclip-accept.sql.gz" });

    expect(res.status).toBe(202);
    expect(typeof res.body.jobId).toBe("string");
    expect(res.body.state).toBe("accepted");

    const jobFile = JSON.parse(fs.readFileSync(activeJobFilePath(homeDir), "utf8"));
    expect(jobFile.state).toBe("accepted");
    expect(jobFile.backupId).toBe("paperclip-accept.sql.gz");
    expect(jobFile.jobId).toBe(res.body.jobId);
  });

  it("rejects a non-admin board user without creating a job file", async () => {
    const backupDir = createTempBackupDir();
    const homeDir = createTempHomeDir();
    writeValidBackupWithManifest(backupDir, "paperclip-reject-admin.sql.gz");

    const res = await request(createApp(nonAdminActor, { backupDir, homeDir }))
      .post("/api/instance/database-restores/jobs")
      .send({ backupId: "paperclip-reject-admin.sql.gz" });

    expect(res.status).toBe(403);
    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(false);
  });

  describe("cloud-managed floor", () => {
    it("floors the restore-accept endpoint off for every instance admin on a cloud-managed instance", async () => {
      process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
      try {
        const backupDir = createTempBackupDir();
        const homeDir = createTempHomeDir();
        writeValidBackupWithManifest(backupDir, "paperclip-cloud.sql.gz");

        const res = await request(createApp(adminActor, { backupDir, homeDir }))
          .post("/api/instance/database-restores/jobs")
          .send({ backupId: "paperclip-cloud.sql.gz" });

        expect(res.status).toBe(403);
        expect(res.body.details).toMatchObject({ code: "database_restores_platform_managed" });
        expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(false);
      } finally {
        delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      }
    });
  });

  it("rejects a backupId containing a path separator before touching the filesystem", async () => {
    const backupDir = createTempBackupDir();
    const homeDir = createTempHomeDir();

    const res = await request(createApp(adminActor, { backupDir, homeDir }))
      .post("/api/instance/database-restores/jobs")
      .send({ backupId: "../escape.sql.gz" });

    expect(res.status).toBe(400);
    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(false);
  });

  it("rejects a backupId that does not exist in the backup directory", async () => {
    const backupDir = createTempBackupDir();
    const homeDir = createTempHomeDir();

    const res = await request(createApp(adminActor, { backupDir, homeDir }))
      .post("/api/instance/database-restores/jobs")
      .send({ backupId: "paperclip-does-not-exist.sql.gz" });

    expect(res.status).toBe(404);
    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(false);
  });

  it("rejects a backup whose manifest is not valid (missing)", async () => {
    const backupDir = createTempBackupDir();
    const homeDir = createTempHomeDir();
    fs.writeFileSync(path.join(backupDir, "paperclip-no-manifest-accept.sql.gz"), "content", "utf8");

    const res = await request(createApp(adminActor, { backupDir, homeDir }))
      .post("/api/instance/database-restores/jobs")
      .send({ backupId: "paperclip-no-manifest-accept.sql.gz" });

    expect(res.status).toBe(400);
    expect(fs.existsSync(activeJobFilePath(homeDir))).toBe(false);
  });

  it("ignores any client-supplied manifestSha256 and records the server-verified value instead", async () => {
    const backupDir = createTempBackupDir();
    const homeDir = createTempHomeDir();
    const { sha256 } = writeValidBackupWithManifest(backupDir, "paperclip-ignore-client-sha.sql.gz");

    const res = await request(createApp(adminActor, { backupDir, homeDir }))
      .post("/api/instance/database-restores/jobs")
      .send({ backupId: "paperclip-ignore-client-sha.sql.gz", manifestSha256: "f".repeat(64) });

    expect(res.status).toBe(202);
    const jobFile = JSON.parse(fs.readFileSync(activeJobFilePath(homeDir), "utf8"));
    expect(jobFile.manifestSha256).toBe(sha256);
    expect(jobFile.manifestSha256).not.toBe("f".repeat(64));
  });

  it("rejects a second sequential accept request with 409 while a job is already active", async () => {
    const backupDir = createTempBackupDir();
    const homeDir = createTempHomeDir();
    writeValidBackupWithManifest(backupDir, "paperclip-first.sql.gz");
    writeValidBackupWithManifest(backupDir, "paperclip-second.sql.gz");

    const first = await request(createApp(adminActor, { backupDir, homeDir }))
      .post("/api/instance/database-restores/jobs")
      .send({ backupId: "paperclip-first.sql.gz" });
    expect(first.status).toBe(202);

    const second = await request(createApp(adminActor, { backupDir, homeDir }))
      .post("/api/instance/database-restores/jobs")
      .send({ backupId: "paperclip-second.sql.gz" });

    expect(second.status).toBe(409);
    const jobFile = JSON.parse(fs.readFileSync(activeJobFilePath(homeDir), "utf8"));
    expect(jobFile.backupId).toBe("paperclip-first.sql.gz");
  });

  it("handles two truly concurrent accept requests: exactly one 202, one 409, and exactly one job file", async () => {
    const backupDir = createTempBackupDir();
    const homeDir = createTempHomeDir();
    writeValidBackupWithManifest(backupDir, "paperclip-concurrent-a.sql.gz");
    writeValidBackupWithManifest(backupDir, "paperclip-concurrent-b.sql.gz");

    const app = createApp(adminActor, { backupDir, homeDir });

    const [resA, resB] = await Promise.all([
      request(app).post("/api/instance/database-restores/jobs").send({ backupId: "paperclip-concurrent-a.sql.gz" }),
      request(app).post("/api/instance/database-restores/jobs").send({ backupId: "paperclip-concurrent-b.sql.gz" }),
    ]);

    expect([resA.status, resB.status].sort((x, y) => x - y)).toEqual([202, 409]);

    const jobsDir = path.dirname(activeJobFilePath(homeDir));
    expect(fs.readdirSync(jobsDir)).toEqual(["active-job.json"]);

    const winner = resA.status === 202 ? resA : resB;
    const raw = fs.readFileSync(activeJobFilePath(homeDir), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.jobId).toBe(winner.body.jobId);
  });

  it("stores no absolute paths, connection strings, or secrets in the job file", async () => {
    const backupDir = createTempBackupDir();
    const homeDir = createTempHomeDir();
    writeValidBackupWithManifest(backupDir, "paperclip-no-secrets.sql.gz");

    await request(createApp(adminActor, { backupDir, homeDir }))
      .post("/api/instance/database-restores/jobs")
      .send({ backupId: "paperclip-no-secrets.sql.gz" });

    const raw = fs.readFileSync(activeJobFilePath(homeDir), "utf8");
    expect(raw.includes(backupDir)).toBe(false);
    expect(raw.includes(homeDir)).toBe(false);
    expect(raw.toLowerCase().includes("password")).toBe(false);
    expect(raw.toLowerCase().includes("connectionstring")).toBe(false);
  });
});
