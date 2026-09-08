import { z } from "zod";

/**
 * Versioned, validated DelegationPlan contract for the JARVIS Delegation Loop
 * MVP (see docs/architecture/jarvis-delegation-loop-mvp-plan.md §5.2). This
 * schema is the server-enforced boundary: a plan produced by JARVIS (a
 * model-authored artifact) must pass this validator before any child Issue
 * is created. Prompt instructions alone are not a security boundary.
 */
export const JARVIS_DELEGATION_PLAN_SCHEMA_VERSION = 1 as const;

export const DELEGATION_TASK_CLASSES = [
  "planning",
  "research",
  "development",
  "qa",
  "security",
  "operations",
  "documentation",
  "knowledge",
  "coordination",
] as const;

export type DelegationTaskClass = (typeof DELEGATION_TASK_CLASSES)[number];

const trimmedNonEmptyString = z.string().trim().min(1);

export const delegationTaskSchema = z.object({
  title: trimmedNonEmptyString.max(200),
  instructions: trimmedNonEmptyString,
  requiredCapabilities: z.array(trimmedNonEmptyString).max(20).default([]),
  dependencies: z.array(trimmedNonEmptyString).max(20).default([]),
  riskHints: z.array(trimmedNonEmptyString).max(20).default([]),
});

export type DelegationTask = z.infer<typeof delegationTaskSchema>;

/**
 * The general shape allows up to 5 tasks (matching the MVP's bounded
 * children-per-decision limit in jarvis-delegation-limits.ts) so the same
 * contract can later carry a Milestone 2 multi-child plan without a breaking
 * shape change. Milestone 1 additionally requires exactly one task; that
 * narrower rule is enforced separately by assertSingleSpecialistPlan below,
 * not baked into the shape itself.
 */
export const delegationPlanSchema = z.object({
  version: z.literal(JARVIS_DELEGATION_PLAN_SCHEMA_VERSION),
  parentIssueId: trimmedNonEmptyString,
  objective: trimmedNonEmptyString,
  constraints: z.array(trimmedNonEmptyString).max(50).default([]),
  acceptanceCriteria: z.array(trimmedNonEmptyString).min(1).max(50),
  evidenceRequirements: z.array(trimmedNonEmptyString).min(1).max(20),
  reviewRequired: z.boolean().default(false),
  taskClass: z.enum(DELEGATION_TASK_CLASSES),
  tasks: z.array(delegationTaskSchema).min(1).max(5),
  memoryRefs: z.array(trimmedNonEmptyString).max(50).default([]),
});

export type DelegationPlan = z.infer<typeof delegationPlanSchema>;

export interface DelegationPlanValidationResult {
  ok: boolean;
  plan: DelegationPlan | null;
  errors: string[];
}

export function validateDelegationPlan(input: unknown): DelegationPlanValidationResult {
  const result = delegationPlanSchema.safeParse(input);
  if (result.success) {
    return { ok: true, plan: result.data, errors: [] };
  }
  return {
    ok: false,
    plan: null,
    errors: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  };
}

export interface SingleSpecialistPlanCheck {
  ok: boolean;
  error: string | null;
}

/**
 * Milestone 1 (Paperclip-native, single-specialist vertical slice) is
 * explicitly limited to one task per plan
 * (docs/architecture/jarvis-delegation-loop-mvp-plan.md §8). This is kept as
 * a separate check from delegationPlanSchema so multi-task plans remain
 * structurally valid (for Milestone 2) while still being rejected by the
 * Milestone 1 orchestration path.
 */
export function assertSingleSpecialistPlan(plan: DelegationPlan): SingleSpecialistPlanCheck {
  if (plan.tasks.length !== 1) {
    return {
      ok: false,
      error: `Milestone 1 requires exactly one task per delegation plan; received ${plan.tasks.length}.`,
    };
  }
  return { ok: true, error: null };
}
