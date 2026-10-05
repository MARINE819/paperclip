import {
  validateDelegationPlan,
  JARVIS_DELEGATION_PLAN_SCHEMA_VERSION,
  type DelegationTaskClass,
} from "./jarvis-delegation-plan.js";
import type { SubmitToJarvisPlanInput } from "./jarvis-delegation-orchestrator.js";

/**
 * M2-06: deterministic text -> minimal valid DelegationPlan translator.
 *
 * This exists ONLY to satisfy submitToJarvis's existing, unmodified
 * SubmitToJarvisPlanInput/validateDelegationPlan contract for a short,
 * free-text (voice or mobile) instruction — it is not a new JARVIS system,
 * not an approval mechanism, and not an agent selector. It never guesses a
 * specialist agent (that remains selectDeterministicSpecialist's job,
 * downstream and untouched) and never invents false-precision acceptance
 * criteria or evidence requirements — every generated field is either the
 * caller's own text verbatim or an explicitly generic placeholder, never a
 * fabricated specific claim.
 *
 * requiredCapabilities is deliberately always [] : selectDeterministicSpecialist's
 * own hasCapability() treats an empty required-capability string as
 * automatically satisfied, and an empty array here means "no hard capability
 * filter" — every assignable, non-orchestrator company agent remains
 * eligible, with the EXISTING availability/priority/stable-id ranking
 * deciding deterministically. Guessing a capability string here would risk
 * wrongly excluding the correct agent, which is exactly the "don't guess a
 * specialist" rule applied one level earlier in the pipeline.
 *
 * taskClass has no "unknown"/default case in the schema (it's a required
 * enum) — classification here is a minimal, deterministic keyword scan, the
 * same pattern already established and approved for TaskProfile
 * classification (task-profile-classifier.ts) in M2-05, for the same reason:
 * an LLM choosing its own classification would be circular. Defaults to
 * "development" (the most general, catch-all case) when no keyword matches,
 * exactly mirroring that classifier's own default-to-the-general-case rule.
 */

const TASK_CLASS_KEYWORDS: ReadonlyArray<readonly [DelegationTaskClass, readonly string[]]> = [
  ["security", ["security", "vulnerability", "exploit", "credential", "secret leak"]],
  ["qa", ["test", "bug", "flaky", "regression", "qa"]],
  ["research", ["research", "investigate", "compare", "find out", "survey"]],
  ["planning", ["plan", "roadmap", "design doc", "proposal"]],
  ["documentation", ["document", "docs", "readme", "write up"]],
  ["operations", ["deploy", "restart", "reboot", "incident", "migrate", "backup", "monitor"]],
  ["knowledge", ["knowledge base", "wiki", "memory"]],
  ["coordination", ["coordinate", "delegate", "assign", "sync up"]],
];

function classifyTaskClass(normalizedText: string): DelegationTaskClass {
  for (const [taskClass, keywords] of TASK_CLASS_KEYWORDS) {
    if (keywords.some((kw) => normalizedText.includes(kw))) return taskClass;
  }
  return "development";
}

const MAX_TITLE_LENGTH = 200;

function deriveTaskTitle(requestText: string): string {
  return requestText.length > MAX_TITLE_LENGTH
    ? `${requestText.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : requestText;
}

export interface BuildMinimalDelegationPlanResult {
  ok: boolean;
  plan: SubmitToJarvisPlanInput | null;
  errors: string[];
}

/**
 * Builds a minimal, single-task DelegationPlan from a short free-text
 * instruction, then re-validates it through the EXISTING, unmodified
 * validateDelegationPlan (using placeholder version/parentIssueId values
 * purely to satisfy that validator's shape — the real submitToJarvis call
 * fills in the real ones itself; this function's own output never carries
 * version/parentIssueId, matching SubmitToJarvisPlanInput exactly).
 *
 * Fails closed (ok: false, plan: null) for empty/whitespace-only input or
 * anything validateDelegationPlan itself would reject — never returns a
 * best-effort plan the caller didn't ask for.
 */
export function buildMinimalDelegationPlanFromText(
  requestText: string,
  options?: { reviewRequired?: boolean },
): BuildMinimalDelegationPlanResult {
  const trimmed = requestText?.trim();
  if (!trimmed) {
    return { ok: false, plan: null, errors: ["requestText is required and cannot be blank."] };
  }

  const reviewRequired = options?.reviewRequired ?? false;
  const taskClass = classifyTaskClass(trimmed.toLowerCase());
  const plan: SubmitToJarvisPlanInput = {
    objective: trimmed,
    acceptanceCriteria: ["The requested task is completed as described in the request text."],
    evidenceRequirements: ["work_product"],
    reviewRequired,
    taskClass,
    tasks: [
      {
        title: deriveTaskTitle(trimmed),
        instructions: trimmed,
        requiredCapabilities: [],
        dependencies: [],
        riskHints: [],
      },
    ],
  };

  // Re-validate through the existing, unmodified validator before returning
  // anything — this function must never hand back a plan that
  // validateDelegationPlan would itself reject.
  const validation = validateDelegationPlan({
    version: JARVIS_DELEGATION_PLAN_SCHEMA_VERSION,
    parentIssueId: "pending", // placeholder only — the real call fills in the real id; this field is not part of SubmitToJarvisPlanInput's own shape.
    objective: plan.objective,
    constraints: [],
    acceptanceCriteria: plan.acceptanceCriteria,
    evidenceRequirements: plan.evidenceRequirements,
    reviewRequired,
    taskClass: plan.taskClass,
    tasks: plan.tasks,
    memoryRefs: [],
  });
  if (!validation.ok) {
    return { ok: false, plan: null, errors: validation.errors };
  }

  return { ok: true, plan, errors: [] };
}
