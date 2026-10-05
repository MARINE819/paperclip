import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, notFound, unauthorized } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { getSecretsRegistryEntry, listSecretsRegistry, type SecretsRegistryEntryType } from "../services/secrets-registry.js";

// F-02 Secrets/Credential Management — read-only unified registry across
// company secrets, agent API keys, and board API keys. Reuses the exact
// same auth gate (assertBoard + assertCompanyAccess) as the existing
// GET /companies/:companyId/secrets route for the same underlying company
// secrets data — no new authorization concept introduced. Never returns
// plaintext or touches encrypted material; see
// server/src/services/secrets-registry.ts and
// docs/contracts/nexora-f02-secrets-api.md.

const VALID_TYPES: SecretsRegistryEntryType[] = ["secret", "agent_api_key", "board_api_key"];

// Board API key entries can only ever be scoped to a real, known caller —
// an unidentifiable requester fails closed rather than silently omitting
// or (worse) matching everyone's board keys.
function requireRequestingUserId(req: Request): string {
  const userId = req.actor.type === "board" ? req.actor.userId : undefined;
  if (!userId) throw unauthorized("A board actor with a known userId is required");
  return userId;
}

export function secretsRegistryRoutes(db: Db) {
  const router = Router();

  router.get("/secrets", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    if (!companyId) throw badRequest("companyId query parameter is required");
    assertCompanyAccess(req, companyId);
    const requestingUserId = requireRequestingUserId(req);
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    if (type && !VALID_TYPES.includes(type as SecretsRegistryEntryType)) {
      throw badRequest(`type must be one of ${VALID_TYPES.join(", ")}`);
    }
    const entries = await listSecretsRegistry(db, {
      companyId,
      requestingUserId,
      type: type as SecretsRegistryEntryType | undefined,
    });
    res.json({ entries });
  });

  router.get("/secrets/:id", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    if (!companyId) throw badRequest("companyId query parameter is required");
    assertCompanyAccess(req, companyId);
    const requestingUserId = requireRequestingUserId(req);
    const entry = await getSecretsRegistryEntry(db, req.params.id, { companyId, requestingUserId });
    if (!entry) throw notFound("Secrets registry entry not found");
    res.json({ entry });
  });

  return router;
}
