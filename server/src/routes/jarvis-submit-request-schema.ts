import { z } from "zod";
import { delegationPlanSchema } from "../services/jarvis-delegation-plan.js";

/**
 * Request body schema for POST /companies/:companyId/jarvis/submit
 * (docs/investigations/jarvis-delegation-loop-application-wiring-review.md
 * §1.3, §2.1). Composed from the already-implemented delegationPlanSchema
 * (server/src/services/jarvis-delegation-plan.ts) rather than re-declaring
 * its fields — `version` and `parentIssueId` are supplied by the orchestrator
 * itself, not the caller, since the parent Issue does not exist yet at
 * request time.
 */
export const submitToJarvisRequestSchema = z.object({
  jarvisAgentId: z.string().trim().min(1),
  requestText: z.string().trim().min(1),
  sourceType: z.string().trim().min(1).optional(),
  sourceRef: z.string().trim().min(1).optional().nullable(),
  idempotencyKey: z.string().trim().min(1).optional().nullable(),
  depthBelowParent: z.number().int().nonnegative().optional(),
  plan: delegationPlanSchema.omit({ version: true, parentIssueId: true }),
});

export type SubmitToJarvisRequestBody = z.infer<typeof submitToJarvisRequestSchema>;
