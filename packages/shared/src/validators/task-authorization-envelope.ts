import { z } from "zod";

/**
 * NEXORA Master 2 — Task Authorization Envelope (Phase 1: schema only).
 *
 * This module is deliberately inert in Phase 1: it defines the shape of an
 * envelope and the pure question "is this action inside it", but nothing in
 * this repository writes an envelope, reads one at execution time, or lets
 * it affect the existing Human Approval Gate. See
 * `server/src/services/task-authorization-envelope.ts` for the pure
 * evaluation function, and `doc/plans/` for the phased rollout plan.
 */
export const TASK_AUTHORIZATION_LEVELS = ["read_only", "safe_mutation", "system_change"] as const;
export type TaskAuthorizationLevel = (typeof TASK_AUTHORIZATION_LEVELS)[number];

/**
 * Actions in this list can never be authorized by an envelope, regardless of
 * its contents — they always require a fresh Human Approval Gate decision.
 * This is enforced in code (`isActionWithinEnvelope` below), not merely by
 * this list's existence, so an envelope's own JSON can never widen it.
 */
export const ALWAYS_REAPPROVE_ACTIONS = [
  "bulk_delete",
  "db_direct_mutation",
  "external_message_send",
  "git_push",
  "deploy",
  "permission_change",
  "security_change",
  "emergency_stop",
] as const;
export type AlwaysReapproveAction = (typeof ALWAYS_REAPPROVE_ACTIONS)[number];

export const taskAuthorizationRiskCeilingSchema = z.enum(["LOW", "HIGH"]);

/**
 * A specific external resource an envelope's scope is pinned to. Each
 * resource `type` owns its own shape — Google Sheets scope is deliberately
 * its own object rather than overloading `allowedPaths`/`allowedServiceActions`,
 * since a spreadsheetId/sheetName pair has no meaningful relationship to a
 * filesystem path or an arbitrary service-action string.
 */
export const taskAuthorizationResourceSchema = z.object({
  type: z.literal("google_sheet"),
  spreadsheetId: z.string().trim().min(1),
  // Omitted entirely means "no sheet/tab restriction expressible by this PoC"
  // — callers must treat a resource with no sheetName as not matching any
  // parsed sheet name, per the fail-closed rule (see
  // server/src/services/task-authorization-envelope.ts).
  sheetName: z.string().trim().min(1).optional(),
}).catchall(z.unknown());
export type TaskAuthorizationResource = z.infer<typeof taskAuthorizationResourceSchema>;

export const taskAuthorizationEnvelopeSchema = z.object({
  version: z.literal(1),
  level: z.enum(TASK_AUTHORIZATION_LEVELS),
  allowedPaths: z.array(z.string().trim().min(1)).optional(),
  allowedApiMethods: z.array(z.enum(["GET", "POST", "PATCH", "DELETE"])).optional(),
  allowedServiceActions: z.array(z.string().trim().min(1)).optional(),
  // Deliberately excludes "push"/"deploy" as valid values — those live only
  // in ALWAYS_REAPPROVE_ACTIONS and can never appear in an allow-list.
  allowedGitActions: z.array(z.enum(["commit", "branch"])).optional(),
  allowedResources: z.array(taskAuthorizationResourceSchema).optional(),
  riskCeiling: taskAuthorizationRiskCeilingSchema.default("LOW"),
  maxOperations: z.number().int().positive().optional(),
  expiresAt: z.string().datetime({ offset: true }),
  issuedByUserId: z.string().min(1),
}).catchall(z.unknown());

export type TaskAuthorizationEnvelope = z.infer<typeof taskAuthorizationEnvelopeSchema>;
