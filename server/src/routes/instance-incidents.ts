import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { listOpenIncidents, listResolvedIncidents, type RuntimeIncidentRow } from "../services/incident-store.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { promoteIncidentFailureMemoryToCandidate } from "../services/failure-memory-promotion.js";

// Minimal Control Center visibility surface for F-06 — deliberately thin
// (read-only, no new UI): reuses the same admin gate as the manual backup
// route rather than inventing a new authorization concept.
function toSummary(row: RuntimeIncidentRow) {
  return {
    id: row.id,
    code: row.code,
    severity: row.severity,
    status: row.status,
    affectedComponents: row.affectedComponents,
    detectedAt: row.detectedAt,
    lastObservedAt: row.lastObservedAt,
    resolvedAt: row.resolvedAt,
    occurrenceCount: row.occurrenceCount,
    recoveryAttempted: row.recoveryAttempted,
    recoveryResult: row.recoveryResult,
    rootCauseStatus: row.rootCauseStatus,
    failureMemoryCandidate: row.failureMemoryCandidate,
  };
}

export function instanceIncidentRoutes(db: Db) {
  const router = Router();

  router.get("/instance/incidents", async (req, res) => {
    assertInstanceAdmin(req);
    const instanceId = typeof req.query.instanceId === "string" ? req.query.instanceId : "default";
    const [open, resolved] = await Promise.all([
      listOpenIncidents(db, instanceId),
      listResolvedIncidents(db, instanceId),
    ]);
    res.json({
      open: open.map(toSummary),
      resolved: resolved.map(toSummary),
    });
  });

  // JARVIS-01: Board-triggered only (no automatic/background trigger in
  // this batch). Creates a reviewable memoryOperations candidate — never
  // auto-verified knowledge. Requires BOTH instance-admin AND access to
  // the target company; no implicit/default company selection. See
  // docs/contracts/jarvis-01-failure-memory-closure-loop.md.
  router.post("/instance/incidents/:id/promote-failure-memory", async (req, res) => {
    assertInstanceAdmin(req);
    const companyId = typeof req.body?.companyId === "string" ? req.body.companyId.trim() : "";
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const result = await promoteIncidentFailureMemoryToCandidate(db, companyId, req.params.id as string, actor);

    if (result.outcome === "skipped") {
      if (result.reason === "incident_not_found") throw notFound("Incident not found");
      if (result.reason === "company_not_found") throw badRequest("companyId does not reference an existing company");
      throw conflict(`Incident is not eligible for failure-memory promotion: ${result.reason}`, { reason: result.reason });
    }
    res.status(result.outcome === "created" ? 201 : 200).json(result);
  });

  return router;
}
