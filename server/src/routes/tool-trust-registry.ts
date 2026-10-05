import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { ToolRiskLevel, ToolTrustStatus } from "@paperclipai/shared";
import { TOOL_RISK_LEVELS, TOOL_TRUST_STATUSES } from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { assertInstanceAdmin } from "./authz.js";
import {
  PluginNotFoundError,
  getTrustRegistryEntry,
  listTrustRegistry,
  reviewPluginTrust,
  type TrustRegistryRow,
} from "../services/tool-trust-registry.js";
import type { TrustRegistryEntryType } from "../services/tool-trust-decision.js";

// F-05 Tool / Plugin Trust Registry routes. GET endpoints are the
// Antigravity-facing contract documented in
// docs/contracts/nexora-f05-tool-trust-api.md. The POST review endpoint is
// Claude-internal/admin-only — it is the SOLE write path for plugin trust
// status and structurally requires a human reviewedByUserId (no agent
// parameter exists), enforcing "no agent self-promotion" at the API layer,
// not just by convention.

function toSummary(row: TrustRegistryRow) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    provider: row.provider,
    version: row.version,
    source: row.source,
    sourceUrl: row.sourceUrl,
    trustStatus: row.trustStatus,
    riskLevel: row.riskLevel,
    requestedScopes: row.requestedScopes,
    approvedScopes: row.approvedScopes,
    signature: row.signature,
    signatureVerified: row.signatureVerified,
    enabled: row.enabled,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    companyId: row.companyId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const VALID_TYPES: TrustRegistryEntryType[] = ["tool", "mcp", "plugin"];

export function toolTrustRegistryRoutes(db: Db) {
  const router = Router();

  router.get("/tools/trust-registry", async (req, res) => {
    assertInstanceAdmin(req);
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const trustStatus = typeof req.query.trustStatus === "string" ? req.query.trustStatus : undefined;
    const enabledRaw = typeof req.query.enabled === "string" ? req.query.enabled : undefined;
    if (type && !VALID_TYPES.includes(type as TrustRegistryEntryType)) {
      throw badRequest(`type must be one of ${VALID_TYPES.join(", ")}`);
    }
    if (trustStatus && !TOOL_TRUST_STATUSES.includes(trustStatus as ToolTrustStatus)) {
      throw badRequest(`trustStatus must be one of ${TOOL_TRUST_STATUSES.join(", ")}`);
    }
    const entries = await listTrustRegistry(db, {
      type: type as TrustRegistryEntryType | undefined,
      trustStatus: trustStatus as ToolTrustStatus | undefined,
      enabled: enabledRaw === undefined ? undefined : enabledRaw === "true",
    });
    res.json({ entries: entries.map(toSummary) });
  });

  router.get("/tools/trust-registry/:id", async (req, res) => {
    assertInstanceAdmin(req);
    const entry = await getTrustRegistryEntry(db, req.params.id);
    if (!entry) throw notFound("Trust registry entry not found");
    res.json({ entry: toSummary(entry) });
  });

  router.post("/tools/trust-registry/plugins/:pluginId/review", async (req, res) => {
    assertInstanceAdmin(req);
    const body = req.body as Record<string, unknown>;
    if (typeof body?.trustStatus !== "string" || !TOOL_TRUST_STATUSES.includes(body.trustStatus as ToolTrustStatus)) {
      throw badRequest(`trustStatus is required and must be one of ${TOOL_TRUST_STATUSES.join(", ")}`);
    }
    if (typeof body?.reviewedByUserId !== "string" || !body.reviewedByUserId.trim()) {
      throw badRequest("reviewedByUserId is required — a human reviewer, never an agent");
    }
    if (body.riskLevel !== undefined && !TOOL_RISK_LEVELS.includes(body.riskLevel as ToolRiskLevel)) {
      throw badRequest(`riskLevel must be one of ${TOOL_RISK_LEVELS.join(", ")}`);
    }
    try {
      const entry = await reviewPluginTrust(db, {
        pluginId: req.params.pluginId,
        trustStatus: body.trustStatus as ToolTrustStatus,
        riskLevel: typeof body.riskLevel === "string" ? (body.riskLevel as ToolRiskLevel) : undefined,
        approvedScopes: Array.isArray(body.approvedScopes) ? body.approvedScopes : undefined,
        reviewedByUserId: body.reviewedByUserId,
      });
      res.status(200).json({ entry: toSummary(entry) });
    } catch (error) {
      if (error instanceof PluginNotFoundError) throw notFound(error.message);
      throw error;
    }
  });

  return router;
}
