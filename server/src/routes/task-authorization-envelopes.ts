import { Router } from "express";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { taskAuthorizationEnvelopes, type Db } from "@paperclipai/db";
import { taskAuthorizationEnvelopeSchema } from "@paperclipai/shared/validators/task-authorization-envelope";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { notFound } from "../errors.js";

/**
 * NEXORA Master 2 — Task Authorization Envelope Phase 2 PoC.
 *
 * Board-only. There is deliberately no update/expand endpoint — an envelope
 * is immutable once created; the only state transition exposed here is a
 * one-way revoke. `issuedByUserId`/`revokedByUserId` are always taken from
 * the authenticated board actor, never from the request body, so an agent
 * (which never reaches these routes under `assertBoard`) could not forge
 * them even if it could reach the endpoint.
 */

// issuedByUserId is intentionally omitted from the client-supplied body —
// the server fills it from the authenticated actor below.
const createEnvelopeSchema = z.object({
  issueId: z.string().uuid(),
  agentId: z.string().uuid(),
  envelope: taskAuthorizationEnvelopeSchema.omit({ issuedByUserId: true }),
});

export function taskAuthorizationEnvelopeRoutes(db: Db) {
  const router = Router();

  router.post(
    "/companies/:companyId/task-authorization-envelopes",
    validate(createEnvelopeSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { issueId, agentId, envelope } = req.body as z.infer<typeof createEnvelopeSchema>;
      const issuedByUserId = req.actor.userId ?? "board";

      const [created] = await db
        .insert(taskAuthorizationEnvelopes)
        .values({
          companyId,
          issueId,
          agentId,
          level: envelope.level,
          riskCeiling: envelope.riskCeiling,
          allowedResources: envelope.allowedResources ?? [],
          maxOperations: envelope.maxOperations ?? null,
          expiresAt: new Date(envelope.expiresAt),
          issuedByUserId,
        })
        .returning();

      res.status(201).json(created);
    },
  );

  router.post(
    "/companies/:companyId/task-authorization-envelopes/:id/revoke",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const revokedByUserId = req.actor.userId ?? "board";

      const [revoked] = await db
        .update(taskAuthorizationEnvelopes)
        .set({ revokedAt: new Date(), revokedByUserId, updatedAt: new Date() })
        .where(and(
          eq(taskAuthorizationEnvelopes.id, id),
          eq(taskAuthorizationEnvelopes.companyId, companyId),
          isNull(taskAuthorizationEnvelopes.revokedAt),
        ))
        .returning();

      if (!revoked) {
        const [existing] = await db
          .select({ id: taskAuthorizationEnvelopes.id })
          .from(taskAuthorizationEnvelopes)
          .where(and(
            eq(taskAuthorizationEnvelopes.id, id),
            eq(taskAuthorizationEnvelopes.companyId, companyId),
          ));
        if (!existing) throw notFound("Task authorization envelope not found");
        // Already revoked — idempotent success, no second revokedAt write.
        res.status(200).json({ id, alreadyRevoked: true });
        return;
      }

      res.status(200).json(revoked);
    },
  );

  router.get(
    "/companies/:companyId/task-authorization-envelopes",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const issueId = typeof req.query.issueId === "string" ? req.query.issueId : undefined;

      const conditions = [eq(taskAuthorizationEnvelopes.companyId, companyId)];
      if (issueId) conditions.push(eq(taskAuthorizationEnvelopes.issueId, issueId));

      const rows = await db
        .select()
        .from(taskAuthorizationEnvelopes)
        .where(and(...conditions));

      res.json(rows);
    },
  );

  return router;
}
