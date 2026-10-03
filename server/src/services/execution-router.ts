// NEXORA Intelligent Execution Router — top-level orchestrator.
// CEO Task -> TaskProfile -> ExecutionCapabilityRequirements -> Executor
// Registry -> eligible Executor candidates -> (per candidate) Provider/Model
// via EITHER model-router.ts's static registry OR live runtime-discovery ->
// deterministic scoring -> primary selection + bounded fallback chain.
//
// Nests the existing F-09 model-router.ts unchanged as a per-executor
// sub-stage for static_registry executors (resolveRoutedModel is called once
// per eligible candidate, exactly as it already supports via its
// registryAdapterType parameter) rather than rewriting it. runtime_discovery
// executors (antigravity_local, hermes_local, opencode_local — see
// executor-registry.ts) instead query their own CLI live via
// runtime-model-discovery.ts — see docs/investigations for the full design
// rationale.
//
// Eligibility rule (2026-10-03 revision — see execution-router.test.ts):
// the agent's OWN currently-configured executor is eligible under the
// EXACT SAME gate as any peer — enabled, category-eligible, supportsModels,
// operationalStatus==="confirmed_working", and capability/privacy match.
// An unverified or confirmed_broken incumbent does NOT get a free pass
// merely for being the agent's current adapter; it is excluded from the
// dynamic candidate pool exactly like any other unverified executor would
// be. The only escape hatch is an explicit human pin (executorPinned /
// adapterPinned / providerPinned), which fixes routing to the agent's own
// executor unconditionally, bypassing all of this. Within the dynamic
// (unpinned) path, incumbency contributes only the smallest possible,
// final tie-break weight in scoring — see scoreExecutionCandidate.

import {
  classifyTaskProfile,
  type TaskProfile,
  type TaskProfileClassifierInput,
  type CapabilityRequirement,
} from "./task-profile-classifier.js";
import {
  getExecutorRegistry,
  getExecutorByType,
  isDynamicRoutingEligibleCategory,
  executorSatisfiesCapabilities,
  type ExecutorRecord,
  type HealthStatus,
} from "./executor-registry.js";
import { resolveRoutedModel, type RoutingReason } from "./model-router.js";
import { findModelByModelString } from "./model-registry.js";
import type { ModelTier } from "./model-registry.js";
import { discoverRuntimeModels, RUNTIME_DISCOVERY_SOURCES } from "./runtime-model-discovery.js";

// Extends model-router.ts's own RoutingReason with one new value for
// candidates sourced from live runtime discovery rather than the static
// registry. heartbeat.ts's resolveDynamicExecutionRoute wrapper maps this
// down to "tier_routing" for RouteModelResult-compatible consumers (same
// pattern previously used for the now-removed "dynamic_selection" label).
export type ExecutionRoutingReason = RoutingReason | "runtime_discovery";

// Non-null only when routingReason came from the fixed (non-dynamic) path —
// i.e. explains WHY dynamic cross-executor selection was skipped, independent
// of which underlying tier/default reason resolveRoutedModel then produced.
export type FixedRoutingReason = "pinned" | "non_eligible_category" | null;

export interface ExecutionPinState {
  executorPinned?: boolean;
  adapterPinned?: boolean;
  providerPinned?: boolean;
}

export interface ExecutionCandidate {
  executorType: string;
  provider: string | null;
  model: string | null;
  tier: ModelTier | null;
  reason: ExecutionRoutingReason;
}

export interface ExecutionRouteInput {
  agentAdapterType: string | null | undefined;
  runtimeConfigModel?: string | null;
  humanModelTier?: ModelTier | null;
  pinState: ExecutionPinState;
  taskProfileInput: TaskProfileClassifierInput;
  // Registry lookup-only alias for the fixed/pinned path, e.g.
  // paperclip_runner -> codex_local (mirrors resolveEffectiveModelSelection's
  // existing alias in heartbeat.ts). Never influences the returned
  // adapterType, only which adapter's registry rows a fixed/pinned lookup is
  // allowed to read tier/default routing from. Ignored once dynamic routing
  // is eligible (that path scores across the real executor registry instead).
  registryAdapterTypeOverride?: string | null;
}

export interface ExecutionRouteResult {
  taskProfile: TaskProfile;
  selectedExecutor: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  tier: ModelTier | null;
  routingReason: ExecutionRoutingReason;
  fixedRoutingReason: FixedRoutingReason;
  // True only when more than one executor was actually eligible and scored
  // against each other for this decision. False whenever there was exactly
  // one candidate — since no real choice was made between alternatives in
  // that case, even though the code path is the same.
  dynamicallySelected: boolean;
  executorCandidates: readonly string[];
  fallbackChain: readonly ExecutionCandidate[];
  capabilityRequirements: readonly CapabilityRequirement[];
  hardConstraints: { privacyRequirement: TaskProfile["privacyRequirement"] };
  executorHealthAtSelection: HealthStatus | null;
  routerVersion: 1;
}

export const EXECUTION_ROUTER_VERSION = 1 as const;

// Retryable: the primary candidate itself was unreachable/unsupported/
// throttled — advancing to the next capability-equivalent candidate is safe.
// Non-retryable: the failure was about correctness/authorization/safety, not
// candidate availability — retrying a different model/provider would not fix
// it and risks repeating a wasted (or unsafe) attempt. Unknown codes fail
// closed into non-retryable, same convention as every other fail-closed path
// in this codebase.
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "unsupported_model",
  "model_unavailable",
  "provider_unavailable",
  "executor_unavailable",
  "rate_limited",
  "quota_exceeded",
  "transient_provider_error",
  "transient_executor_error",
]);

const NON_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "authentication_failure",
  "permission_failure",
  "policy_rejection",
  "unsafe_action",
  "malformed_request",
  "approval_gate_rejected",
]);

export function classifyExecutionFailure(errorCode: string | null | undefined): "retryable" | "non_retryable" {
  if (!errorCode) return "non_retryable";
  if (RETRYABLE_ERROR_CODES.has(errorCode)) return "retryable";
  if (NON_RETRYABLE_ERROR_CODES.has(errorCode)) return "non_retryable";
  return "non_retryable";
}

export const MAX_FALLBACK_ATTEMPTS = 2; // 3 total attempts (primary + 2 fallbacks)

export function nextFallbackCandidate(
  route: Pick<ExecutionRouteResult, "fallbackChain">,
  fallbackAttemptsMade: number,
): ExecutionCandidate | null {
  if (fallbackAttemptsMade >= MAX_FALLBACK_ATTEMPTS) return null;
  return route.fallbackChain[fallbackAttemptsMade] ?? null;
}

const TIER_RANK: Readonly<Record<ModelTier, number>> = { T1: 1, T2: 2, T3: 3, T4: 4 };

// Generic, category-level task-suitability affinity — NEVER a vendor/
// executor name. Grounded in the category definitions themselves
// (CODING_AGENT_RUNTIME = built for code-editing work; AUTONOMOUS_AGENT_
// RUNTIME = built for broader tool-driven autonomy including browser/gui/
// multi-step orchestration). A category with no listed affinity for a
// taskType scores neutrally (0), never negatively — this is a soft
// preference, not a capability gate (that's already enforced separately).
const CODING_AFFINITY_TASK_TYPES: ReadonlySet<TaskProfile["taskType"]> = new Set(["coding"]);
const AUTONOMY_AFFINITY_TASK_TYPES: ReadonlySet<TaskProfile["taskType"]> = new Set([
  "browser_automation",
  "gui_automation",
  "multi_agent_workflow",
  "tool_execution",
]);

function taskSuitabilityScore(taskType: TaskProfile["taskType"], category: ExecutorRecord["category"]): number {
  if (CODING_AFFINITY_TASK_TYPES.has(taskType) && category === "CODING_AGENT_RUNTIME") return 1;
  if (AUTONOMY_AFFINITY_TASK_TYPES.has(taskType) && category === "AUTONOMOUS_AGENT_RUNTIME") return 1;
  return 0;
}

function reliabilityScore(healthStatus: HealthStatus): number {
  if (healthStatus === "healthy") return 1;
  if (healthStatus === "degraded") return -1;
  return 0; // "unknown"
}

function tierFitScore(difficultyTier: TaskProfile["difficultyTier"], candidateTier: ModelTier | null): number {
  const difficultyRank = TIER_RANK[difficultyTier];
  const candidateRank = candidateTier ? TIER_RANK[candidateTier] : TIER_RANK.T2;
  return -Math.abs(difficultyRank - candidateRank); // 0 (perfect fit) to -3 (max mismatch)
}

function costPreferenceScore(costPreference: TaskProfile["costPreference"], candidateTier: ModelTier | null): number {
  const candidateRank = candidateTier ? TIER_RANK[candidateTier] : TIER_RANK.T2;
  if (costPreference === "cheapest") return -candidateRank; // lower tier (cheaper) scores higher
  if (costPreference === "quality_first") return candidateRank; // higher tier scores higher
  return 0; // "balanced" — no cost-driven preference
}

function latencyPreferenceScore(latencyPreference: TaskProfile["latencyPreference"], speedClass: ExecutorRecord["speedClass"]): number {
  const speedRank = { fast: 2, standard: 1, slow: 0 }[speedClass];
  if (latencyPreference === "fast") return speedRank; // prefers faster executors
  return 0; // "normal"/"patient" — no latency-driven preference
}

// Priority order implemented here (CEO-specified, 2026-10-03 revision):
//   1. hard policy/privacy        -> enforced as a FILTER before this function runs
//   2. verified operational state -> enforced as a FILTER (confirmed_working required)
//   3. required capability        -> enforced as a FILTER
//   4. explicit human pin         -> handled as a separate short-circuit path entirely
//   5. task suitability   (weight 10,000 — dominates everything below)
//   6. quality/reliability (weight 1,000)
//   7. difficulty/tier fit (weight 100, max magnitude 300 — strictly below #6's min step)
//   8. cost               (weight 10, max magnitude 40 — strictly below #7's min step)
//   9. latency             (weight 4, max magnitude 8 — strictly below #8's min step)
//   10. incumbency          (weight 1 — the smallest possible, pure tie-break)
// Each weight is chosen so a nonzero difference at any priority level always
// outweighs the maximum possible combined contribution of every lower
// priority level — a strict lexicographic ordering expressed as one
// weighted sum, not an accidental approximation.
export function scoreExecutionCandidate(
  candidate: ExecutionCandidate,
  taskProfile: TaskProfile,
  agentAdapterType?: string | null,
  // The tier actually targeted when candidates were built — humanModelTier
  // when a human explicitly set one, else the classifier's own
  // difficultyTier guess. MUST match what buildCandidateForExecutor used as
  // its tierInput (see resolveExecutionRoute), or tier-fit scoring would
  // compare each candidate against the wrong target: a candidate that only
  // coincidentally lands on the classifier's guessed difficulty (e.g. via an
  // adapter_default_fallback) could then score ABOVE a candidate that
  // correctly honored an explicit human tier override. Defaults to
  // taskProfile.difficultyTier for callers (e.g. pure unit tests) that don't
  // pass it explicitly.
  effectiveTargetTier?: ModelTier,
): number {
  const executor = getExecutorByType(candidate.executorType);
  const suitability = executor ? taskSuitabilityScore(taskProfile.taskType, executor.category) : 0;
  const reliability = executor ? reliabilityScore(executor.healthStatus) : 0;
  const targetTier = effectiveTargetTier ?? taskProfile.difficultyTier;
  const tierFit = tierFitScore(targetTier, candidate.tier);
  const cost = costPreferenceScore(taskProfile.costPreference, candidate.tier);
  const latency = executor ? latencyPreferenceScore(taskProfile.latencyPreference, executor.speedClass) : 0;
  const incumbency = agentAdapterType && candidate.executorType === agentAdapterType ? 1 : 0;
  return (
    suitability * 10_000 +
    reliability * 1_000 +
    tierFit * 100 +
    cost * 10 +
    latency * 4 +
    incumbency * 1
  );
}

function isEligibleForDynamicRouting(executor: ExecutorRecord | null): executor is ExecutorRecord {
  return Boolean(
    executor &&
      isDynamicRoutingEligibleCategory(executor.category) &&
      executor.supportsModels,
  );
}

function passesFullDynamicEligibility(executor: ExecutorRecord, taskProfile: TaskProfile): boolean {
  return (
    isEligibleForDynamicRouting(executor) &&
    executor.enabled &&
    executor.operationalStatus === "confirmed_working" &&
    executorSatisfiesCapabilities(executor, taskProfile.capabilitiesRequired) &&
    (taskProfile.privacyRequirement !== "local_only" || executor.isLocal)
  );
}

function emptyRouteResult(
  taskProfile: TaskProfile,
  agentExecutor: ExecutorRecord | null,
  fixedRoutingReason: FixedRoutingReason = null,
): ExecutionRouteResult {
  return {
    taskProfile,
    selectedExecutor: null,
    selectedProvider: null,
    selectedModel: null,
    tier: null,
    routingReason: "no_route_available",
    fixedRoutingReason,
    dynamicallySelected: false,
    executorCandidates: [],
    fallbackChain: [],
    capabilityRequirements: taskProfile.capabilitiesRequired,
    hardConstraints: { privacyRequirement: taskProfile.privacyRequirement },
    executorHealthAtSelection: agentExecutor?.healthStatus ?? null,
    routerVersion: EXECUTION_ROUTER_VERSION,
  };
}

function fixedExecutorRouteResult(
  taskProfile: TaskProfile,
  agentAdapterType: string,
  registryAdapterTypeOverride: string | null | undefined,
  humanModelTier: ModelTier | null | undefined,
  fixedRoutingReason: Exclude<FixedRoutingReason, null>,
  agentExecutor: ExecutorRecord | null,
): ExecutionRouteResult {
  const routed = resolveRoutedModel({
    agentRuntimeConfigModel: null,
    agentAdapterType,
    registryAdapterType: registryAdapterTypeOverride ?? agentAdapterType,
    tierInput: humanModelTier ?? null,
  });
  if (routed.reason === "no_route_available") {
    return emptyRouteResult(taskProfile, agentExecutor, fixedRoutingReason);
  }
  return {
    taskProfile,
    selectedExecutor: routed.adapterType,
    selectedProvider: routed.provider,
    selectedModel: routed.model,
    tier: routed.tier,
    routingReason: routed.reason,
    fixedRoutingReason,
    dynamicallySelected: false,
    executorCandidates: routed.adapterType ? [routed.adapterType] : [],
    fallbackChain: [],
    capabilityRequirements: taskProfile.capabilitiesRequired,
    hardConstraints: { privacyRequirement: taskProfile.privacyRequirement },
    executorHealthAtSelection: agentExecutor?.healthStatus ?? null,
    routerVersion: EXECUTION_ROUTER_VERSION,
  };
}

async function buildCandidateForExecutor(
  ex: ExecutorRecord,
  input: ExecutionRouteInput,
  taskProfile: TaskProfile,
): Promise<ExecutionCandidate | null> {
  if (ex.modelSourceType === "runtime_discovery") {
    const source = RUNTIME_DISCOVERY_SOURCES[ex.executorType];
    if (!source) return null; // fail-closed: no discovery source registered
    // ex.binaryPath (set for opencode_local — see executor-registry.ts) lets
    // discovery resolve the same machine-local absolute path real dispatch
    // uses, instead of a bare command name that may not be on PATH.
    const discovery = await discoverRuntimeModels(
      ex.executorType,
      (signal) => source(signal, ex.binaryPath ?? undefined),
    );
    if (discovery.status !== "ok" || discovery.models.length === 0) return null; // fail-closed
    const picked = discovery.models[0]!; // deterministic: first of the live list
    return { executorType: ex.executorType, provider: picked.provider, model: picked.model, tier: null, reason: "runtime_discovery" };
  }
  const routed = resolveRoutedModel({
    agentRuntimeConfigModel: null,
    agentAdapterType: ex.adapterType,
    registryAdapterType: ex.adapterType,
    tierInput: input.humanModelTier ?? taskProfile.difficultyTier,
  });
  if (!routed.model) return null;
  return { executorType: ex.executorType, provider: routed.provider, model: routed.model, tier: routed.tier, reason: routed.reason };
}

/**
 * Resolves WHO (executor), WHICH VENDOR (provider), and WHICH MODEL should
 * perform a task. Decision order:
 *   0. Explicit runtimeConfig.model override — always wins, reports whichever
 *      executor that model actually belongs to (even if different from the
 *      agent's own adapterType).
 *   0b. executorPinned/adapterPinned/providerPinned, or the agent's own
 *       adapterType is not a dynamic-routing-eligible category -> fixed to
 *       the agent's own executor, model-only routing within it, regardless
 *       of its operationalStatus (pin is an unconditional escape hatch).
 *   1-3. Hard policy/privacy + verified operational state + required
 *        capability filtering across the FULL executor registry, including
 *        the agent's own executor under the exact same gate as any peer —
 *        an unverified/broken incumbent is excluded like any other
 *        unverified executor, never given a free pass.
 *   5-10. Deterministic joint (executor, model) scoring — task suitability,
 *         reliability, tier/difficulty fit, cost, latency, and finally
 *         incumbency as the smallest-weight tie-break only — primary +
 *         bounded fallback chain (max 2 fallback candidates).
 *   11. Execution and bounded fallback happen at the call site, using
 *       classifyExecutionFailure/nextFallbackCandidate above.
 */
export async function resolveExecutionRoute(input: ExecutionRouteInput): Promise<ExecutionRouteResult> {
  const taskProfile = classifyTaskProfile(input.taskProfileInput);
  const agentAdapterType = input.agentAdapterType ?? null;
  const agentExecutor = agentAdapterType ? getExecutorByType(agentAdapterType) : null;
  const explicitModel = input.runtimeConfigModel?.trim();

  if (explicitModel) {
    const routed = resolveRoutedModel({
      agentRuntimeConfigModel: explicitModel,
      agentAdapterType,
    });
    // A human explicitly naming a model that belongs to a DIFFERENT executor
    // than the agent's own adapterType is read as deliberate intent to run
    // under that executor for this call — resolveRoutedModel's own adapterType
    // field stays the agent's own (its "legacy-compatible path" contract), so
    // the override is applied here instead of inside that shared function.
    const matchedRecord = findModelByModelString(explicitModel);
    const resolvedExecutor = matchedRecord?.adapterType ?? routed.adapterType;
    return {
      taskProfile,
      selectedExecutor: resolvedExecutor,
      selectedProvider: routed.provider,
      selectedModel: routed.model,
      tier: routed.tier,
      routingReason: "agent_explicit_override",
      fixedRoutingReason: null,
      dynamicallySelected: false,
      executorCandidates: resolvedExecutor ? [resolvedExecutor] : [],
      fallbackChain: [],
      capabilityRequirements: taskProfile.capabilitiesRequired,
      hardConstraints: { privacyRequirement: taskProfile.privacyRequirement },
      executorHealthAtSelection: (resolvedExecutor ? getExecutorByType(resolvedExecutor) : agentExecutor)?.healthStatus ?? null,
      routerVersion: EXECUTION_ROUTER_VERSION,
    };
  }

  const isPinned = Boolean(
    input.pinState.executorPinned || input.pinState.adapterPinned || input.pinState.providerPinned,
  );

  if (!agentAdapterType) {
    return emptyRouteResult(taskProfile, null);
  }

  if (isPinned || !isEligibleForDynamicRouting(agentExecutor)) {
    return fixedExecutorRouteResult(
      taskProfile,
      agentAdapterType,
      input.registryAdapterTypeOverride,
      input.humanModelTier,
      isPinned ? "pinned" : "non_eligible_category",
      agentExecutor,
    );
  }

  // Every executor — the agent's own included — passes through the exact
  // same gate. No free pass for an unverified/broken incumbent.
  const eligible = getExecutorRegistry().filter((ex) => passesFullDynamicEligibility(ex, taskProfile));

  if (eligible.length === 0) {
    return emptyRouteResult(taskProfile, agentExecutor);
  }

  const candidateResults = await Promise.all(eligible.map((ex) => buildCandidateForExecutor(ex, input, taskProfile)));
  const candidates = candidateResults.filter((c): c is ExecutionCandidate => c !== null);

  if (candidates.length === 0) {
    return emptyRouteResult(taskProfile, agentExecutor);
  }

  const effectiveTargetTier = input.humanModelTier ?? taskProfile.difficultyTier;
  candidates.sort(
    (a, b) =>
      scoreExecutionCandidate(b, taskProfile, agentAdapterType, effectiveTargetTier) -
      scoreExecutionCandidate(a, taskProfile, agentAdapterType, effectiveTargetTier),
  );
  const [primary, ...rest] = candidates;
  const fallbackChain = rest.slice(0, MAX_FALLBACK_ATTEMPTS);

  return {
    taskProfile,
    selectedExecutor: primary!.executorType,
    selectedProvider: primary!.provider,
    selectedModel: primary!.model,
    tier: primary!.tier,
    // Reports the WINNING candidate's own real reason (tier_routing /
    // adapter_default_fallback / runtime_discovery), never a separate lossy
    // label — see the ExecutionRoutingReason doc comment above.
    routingReason: primary!.reason,
    fixedRoutingReason: null,
    dynamicallySelected: eligible.length > 1,
    executorCandidates: eligible.map((e) => e.executorType),
    fallbackChain,
    capabilityRequirements: taskProfile.capabilitiesRequired,
    hardConstraints: { privacyRequirement: taskProfile.privacyRequirement },
    executorHealthAtSelection: getExecutorByType(primary!.executorType)?.healthStatus ?? null,
    routerVersion: EXECUTION_ROUTER_VERSION,
  };
}
