import { Router } from "express";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { verifyBackupManifest } from "@paperclipai/db/backup-lib";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import { acceptRestoreJob, confirmShutdown } from "../services/restore-control.js";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";

export type BackupCatalogManifestStatus = "valid" | "missing" | "malformed" | "hash_mismatch";

export type BackupCatalogEntry = {
  backupId: string;
  createdAt: string;
  sizeBytes: number;
  manifestStatus: BackupCatalogManifestStatus;
  manifestSha256?: string;
};

export type InstanceDatabaseRestoreCatalogService = {
  backupDir: string;
  /** Test-only override for where restore job files are read/written. */
  homeDir?: string;
};

// Maps verifyBackupManifest's own reason strings (packages/db/src/backup-lib.ts)
// onto this endpoint's four public statuses, without reimplementing any of
// its validation logic.
function classifyManifestReason(reason: string): BackupCatalogManifestStatus {
  if (reason === "manifest missing") return "missing";
  if (reason === "sizeBytes mismatch" || reason === "sha256 mismatch") return "hash_mismatch";
  // Covers every "manifest corrupted: ..." variant and the (effectively
  // unreachable here, since we just listed the file) "backup file missing"
  // case -- both are reported as malformed rather than inventing a fifth
  // status.
  return "malformed";
}

export function instanceDatabaseRestoreCatalogRoutes(service: InstanceDatabaseRestoreCatalogService) {
  const router = Router();

  router.get("/instance/database-restores/catalog", async (req, res) => {
    assertInstanceAdmin(req);
    // Mirrors the floor already applied to manual backups: on cloud-managed
    // instances, backups (and therefore any restore catalog) are platform
    // -owned, and the server-side backup directory layout must not be
    // surfaced to managed tenants.
    if (isCloudManagedInstance()) {
      throw forbidden("Database restore catalog is platform-managed on cloud-managed instances", {
        code: "database_restores_platform_managed",
      });
    }

    const { backupDir } = service;
    if (!existsSync(backupDir)) {
      res.status(200).json({ backups: [] });
      return;
    }

    const candidates = readdirSync(backupDir)
      .filter((name) => name.endsWith(".sql") || name.endsWith(".sql.gz"))
      .map((name) => {
        const fullPath = resolve(backupDir, name);
        const stat = statSync(fullPath);
        return { name, fullPath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const backups: BackupCatalogEntry[] = [];
    for (const candidate of candidates) {
      const verification = await verifyBackupManifest(candidate.fullPath);
      if (verification.ok) {
        backups.push({
          backupId: candidate.name,
          createdAt: new Date(candidate.mtimeMs).toISOString(),
          sizeBytes: candidate.sizeBytes,
          manifestStatus: "valid",
          manifestSha256: verification.manifest.sha256,
        });
      } else {
        backups.push({
          backupId: candidate.name,
          createdAt: new Date(candidate.mtimeMs).toISOString(),
          sizeBytes: candidate.sizeBytes,
          manifestStatus: classifyManifestReason(verification.reason),
        });
      }
    }

    res.status(200).json({ backups });
  });

  router.post("/instance/database-restores/jobs", async (req, res) => {
    assertInstanceAdmin(req);
    if (isCloudManagedInstance()) {
      throw forbidden("Database restore is platform-managed on cloud-managed instances", {
        code: "database_restores_platform_managed",
      });
    }

    const backupId = typeof req.body?.backupId === "string" ? req.body.backupId : "";
    const requestedBy = getActorInfo(req).actorId;

    const result = await acceptRestoreJob({
      backupId,
      backupDir: service.backupDir,
      requestedBy,
      homeDir: service.homeDir,
    });

    if (!result.ok) {
      if (result.httpStatus === 409) {
        throw conflict(result.message, { code: result.code });
      }
      if (result.httpStatus === 404) {
        throw notFound(result.message, { code: result.code });
      }
      throw badRequest(result.message, { code: result.code });
    }

    // 202: the job has only been accepted, not executed. No restore has
    // started, no shutdown has been triggered.
    res.status(202).json({ jobId: result.jobId, state: "accepted" });
  });

  router.post("/instance/database-restores/jobs/:jobId/confirm-shutdown", async (req, res) => {
    assertInstanceAdmin(req);
    if (isCloudManagedInstance()) {
      throw forbidden("Database restore is platform-managed on cloud-managed instances", {
        code: "database_restores_platform_managed",
      });
    }

    const requestedBy = getActorInfo(req).actorId;
    const result = await confirmShutdown({
      jobId: req.params.jobId,
      requestedBy,
      homeDir: service.homeDir,
    });

    if (!result.ok) {
      if (result.httpStatus === 409) {
        throw conflict(result.message, { code: result.code });
      }
      if (result.httpStatus === 404) {
        throw notFound(result.message, { code: result.code });
      }
      throw forbidden(result.message, { code: result.code });
    }

    // 202: a self-targeted restart has only been *requested*. The existing
    // restart-control watcher (unmodified by this batch) decides whether and
    // when to actually shut the process down -- no real shutdown has
    // happened yet.
    res.status(202).json({ jobId: result.jobId, state: result.state });
  });

  return router;
}
