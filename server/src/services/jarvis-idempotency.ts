import { createHash } from "node:crypto";

/**
 * Idempotency and fingerprint helpers for the future submitToJarvis intake
 * command (docs/architecture/jarvis-delegation-loop-mvp-plan.md §5.1) and
 * for the child-decomposition acceptance step
 * (packages/db/src/schema/issue_plan_decompositions.ts already persists a
 * requestFingerprint keyed to companyId + sourceIssueId +
 * acceptedPlanRevisionId). This module only computes deterministic values;
 * it does not read or write the database and does not create or assign any
 * Issue. Wiring it into the actual intake/decomposition routes is
 * integration work deferred to a follow-up slice.
 */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface JarvisIntakeIdempotencyInput {
  companyId: string;
  actorId: string;
  requestText: string;
  sourceType: string;
  sourceRef?: string | null;
  /** Client-supplied idempotency key, if the caller provided one. */
  idempotencyKey?: string | null;
}

export const JARVIS_INTAKE_ORIGIN_KIND = "jarvis_delegation_intake" as const;

export interface JarvisIntakeOrigin {
  originKind: typeof JARVIS_INTAKE_ORIGIN_KIND;
  originId: string;
  originFingerprint: string;
}

function normalizeRequestText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function computeJarvisIntakeFingerprint(input: JarvisIntakeIdempotencyInput): string {
  return sha256Hex(
    stableStringify({
      companyId: input.companyId,
      actorId: input.actorId,
      requestText: normalizeRequestText(input.requestText),
      sourceType: input.sourceType,
      sourceRef: input.sourceRef ?? null,
    }),
  );
}

/**
 * Produces the origin triple to hand to the existing issues.originKind /
 * originId / originFingerprint idempotent-creation pattern
 * (packages/db/src/schema/issues.ts, already used for e.g. routine_execution
 * and task_watchdog). An explicit idempotencyKey is used as-is for originId
 * so a caller-controlled retry key collapses correctly; otherwise the
 * request fingerprint itself doubles as originId so an identical repeated
 * request (no client key supplied) still collapses to one parent Issue.
 */
export function buildJarvisIntakeOrigin(input: JarvisIntakeIdempotencyInput): JarvisIntakeOrigin {
  const fingerprint = computeJarvisIntakeFingerprint(input);
  const trimmedKey = input.idempotencyKey?.trim();
  return {
    originKind: JARVIS_INTAKE_ORIGIN_KIND,
    originId: trimmedKey && trimmedKey.length > 0 ? trimmedKey : fingerprint,
    originFingerprint: fingerprint,
  };
}

/**
 * Fingerprint for a validated DelegationPlan, suitable for the
 * requestFingerprint column on issue_plan_decompositions so repeated
 * decomposition-acceptance calls for the same plan do not create duplicate
 * children.
 */
export function computeDelegationPlanFingerprint(plan: unknown): string {
  return sha256Hex(stableStringify(plan));
}
