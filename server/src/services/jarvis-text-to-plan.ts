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

// SYNC-02 (NEXORA Control Center): the CEO's exact Korean phrase "저장하자"
// is a dedicated daily GitHub-save coordination command, not an ordinary
// development instruction -- it must never fall through to classifyTaskClass's
// generic keyword scan or get a fabricated, task-specific acceptance
// criterion. Matched on the trimmed command only, with trailing punctuation
// stripped (a CEO typing "저장하자!" or "저장하자." means the same exact
// command) -- deliberately narrow: no synonyms, no fuzzy matching, so an
// unrelated instruction that happens to mention "저장" is never misclassified.
export const DAILY_GITHUB_SAVE_COMMAND_RE = /^저장하자[!.?~]*$/;

export function isDailyGithubSaveCommand(normalizedText: string): boolean {
  return DAILY_GITHUB_SAVE_COMMAND_RE.test(normalizedText.trim());
}

const REVIEW_KEYWORDS: readonly string[] = [
  "code review",
  "code-review",
  "peer review",
  "peer-review",
  "independent review",
  "independent-review",
  "review required",
  "review-required",
  "require review",
  "needs review",
  "qa review",
  "코드 리뷰",
  "코드리뷰",
  "독립 검토",
  "독립검토",
  "상호 검토",
  "상호검토",
  "피어 리뷰",
  "피어리뷰",
];

function detectReviewRequired(normalizedText: string): boolean {
  return REVIEW_KEYWORDS.some((kw) => normalizedText.includes(kw));
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

  const normalized = trimmed.toLowerCase();
  const reviewRequired = options?.reviewRequired ?? detectReviewRequired(normalized);

  // SYNC-02: the daily save command gets its own fixed, honest plan content
  // instead of classifyTaskClass's generic keyword scan and the generic
  // single-line acceptance criterion -- the safety conditions below are the
  // actual job, not a fabricated specific claim about unrelated code.
  if (isDailyGithubSaveCommand(trimmed)) {
    const instructions = [
      "한국 시간 기준 당일 NEXORA의 모든 에이전트와 CLI가 완료하고 검증한 작업 전체를 읽기 전용으로 조사하여 GitHub 저장 후보로 정리한다.",
      "당일 완료되고 실제로 검증된 작업만 후보로 선정한다.",
      "조사 범위에는 모든 NEXORA 에이전트와 CLI 작업을 포함한다.",
      "진행 중, 미완료, 테스트 실패, 검증 미실행, 담당자 불명확, 충돌 중인 파일은 후보에서 제외한다.",
      "파일 수정 시각만으로 담당자나 완료 여부를 확정하지 않는다.",
      "포함 대상, 제외 대상, 확인이 필요한 대상을 CEO에게 먼저 보고한다.",
      "git add, commit, push, force push를 포함한 어떤 Git 변경도 직접 실행하지 않는다 — 저장 준비(manifest 작성)까지만 수행한다.",
      "실제 저장은 기존 Git Save Gate를 통해 CEO가 변경 내용을 확인하고 대문자 SAVE를 입력한 경우에만 실행된다.",
    ].join(" ");
    const dailySavePlan: SubmitToJarvisPlanInput = {
      objective: trimmed,
      acceptanceCriteria: [
        "당일 완료·검증된 작업만 GitHub 저장 후보로 선정되고, 진행 중/미완료/테스트 실패/검증 미실행/담당 불명확/충돌 파일은 전부 제외된다.",
        "포함 대상·제외 대상·확인 필요 대상이 CEO에게 보고된다.",
        "git add/commit/push 등 실제 Git 변경은 수행되지 않고, Git Save Gate 저장 준비(manifest)까지만 수행된다.",
      ],
      evidenceRequirements: ["work_product"],
      reviewRequired,
      taskClass: "coordination",
      tasks: [
        {
          title: deriveTaskTitle("저장하자 — 일일 GitHub 저장 후보 조사 및 보고"),
          instructions,
          requiredCapabilities: [],
          dependencies: [],
          riskHints: ["git_mutation", "cross_agent_ownership"],
        },
      ],
    };

    const dailySaveValidation = validateDelegationPlan({
      version: JARVIS_DELEGATION_PLAN_SCHEMA_VERSION,
      parentIssueId: "pending",
      objective: dailySavePlan.objective,
      constraints: [],
      acceptanceCriteria: dailySavePlan.acceptanceCriteria,
      evidenceRequirements: dailySavePlan.evidenceRequirements,
      reviewRequired,
      taskClass: dailySavePlan.taskClass,
      tasks: dailySavePlan.tasks,
      memoryRefs: [],
    });
    if (!dailySaveValidation.ok) {
      return { ok: false, plan: null, errors: dailySaveValidation.errors };
    }
    return { ok: true, plan: dailySavePlan, errors: [] };
  }

  const taskClass = classifyTaskClass(normalized);
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
