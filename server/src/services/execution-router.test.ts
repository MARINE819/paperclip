import { describe, expect, it, vi } from "vitest";

// Deterministic, fast, offline stand-ins for the 3 runtime_discovery
// executors — these pure routing-logic tests must never spawn real CLI
// processes (that's covered separately by runtime-model-discovery.test.ts's
// own spawn-mocked parsing tests, and by the live 2026-10-03 verification
// evidence cited in executor-registry.ts). The returned shapes mirror the
// real, confirmed live responses exactly.
vi.mock("./runtime-model-discovery.js", () => ({
  discoverRuntimeModels: vi.fn(async (cacheKey: string) => {
    const fixed: Record<string, { status: string; models: { model: string; provider: string }[] }> = {
      antigravity_local: { status: "ok", models: [{ model: "gemini-3.8-flash-high", provider: "antigravity" }] },
      hermes_local: { status: "ok", models: [{ model: "nvidia/nemotron-3-super-120b-a12b:free", provider: "hermes" }] },
      opencode_local: { status: "ok", models: [{ model: "big-pickle", provider: "opencode" }] },
    };
    return fixed[cacheKey] ?? { status: "empty", models: [] };
  }),
  RUNTIME_DISCOVERY_SOURCES: { antigravity_local: vi.fn(), hermes_local: vi.fn(), opencode_local: vi.fn() },
}));

import {
  resolveExecutionRoute,
  classifyExecutionFailure,
  nextFallbackCandidate,
  scoreExecutionCandidate,
  MAX_FALLBACK_ATTEMPTS,
  type ExecutionCandidate,
} from "./execution-router.js";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";

const BASE_TASK_PROFILE_INPUT = { title: "Fix bug in the login endpoint", description: "Small, low-risk fix." };

describe("resolveExecutionRoute — explicit override precedence", () => {
  it("explicit runtimeConfig.model always wins, even over a TaskProfile that would otherwise prefer a different executor", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      runtimeConfigModel: "claude-opus-5",
      pinState: {},
      taskProfileInput: BASE_TASK_PROFILE_INPUT,
    });
    expect(route.routingReason).toBe("agent_explicit_override");
    expect(route.selectedModel).toBe("claude-opus-5");
    // Explicit override reports whichever adapter that model actually
    // belongs to (claude_local), not the agent's own adapterType (codex_local).
    expect(route.selectedExecutor).toBe("claude_local");
  });
});

describe("resolveExecutionRoute — pin semantics (requirement #1/#3)", () => {
  it("JARVIS (codex_local, no pin set) is NOT pinned to codex_local — dynamic routing is attempted", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: BASE_TASK_PROFILE_INPUT,
    });
    expect(route.fixedRoutingReason).not.toBe("pinned");
  });

  it("adapterPinned=true fixes routing to the agent's own adapter, byte-identical to v0.1 behavior", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: { adapterPinned: true },
      taskProfileInput: BASE_TASK_PROFILE_INPUT,
    });
    expect(route.fixedRoutingReason).toBe("pinned");
    expect(route.selectedExecutor).toBe("codex_local");
    expect(route.fallbackChain).toEqual([]);
  });

  it("executorPinned and providerPinned independently trigger the same pinned behavior", async () => {
    const a = await resolveExecutionRoute({ agentAdapterType: "codex_local", pinState: { executorPinned: true }, taskProfileInput: BASE_TASK_PROFILE_INPUT });
    const b = await resolveExecutionRoute({ agentAdapterType: "codex_local", pinState: { providerPinned: true }, taskProfileInput: BASE_TASK_PROFILE_INPUT });
    expect(a.fixedRoutingReason).toBe("pinned");
    expect(b.fixedRoutingReason).toBe("pinned");
  });

  it("a non-LLM-category adapter (http) is always treated as fixed, regardless of pin flags — and fails closed since http has no model registry coverage at all", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "http",
      pinState: {},
      taskProfileInput: BASE_TASK_PROFILE_INPUT,
    });
    // http is structurally non-eligible for dynamic routing, but since it also
    // has zero model-registry rows, the fixed-path lookup itself reports
    // no_route_available (the more specific, honest reason) rather than a
    // generic "non_eligible_category" — fixedExecutorRouteResult always lets
    // no_route_available win when the underlying lookup truly finds nothing.
    expect(route.routingReason).toBe("no_route_available");
    expect(route.fixedRoutingReason).toBe("non_eligible_category");
    expect(route.selectedExecutor).toBeNull();
  });
});

describe("resolveExecutionRoute — dynamic selection with today's real registry data (requirement #2)", () => {
  const NO_CAPABILITY_TASK_INPUT = { title: "Write a short release announcement", description: "A couple of sentences." };

  it("an unpinned codex_local agent routes dynamically (not pinned) for a task requiring no special capability, winning by incumbency over its now-confirmed_working peers (claude_local, antigravity_local)", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: NO_CAPABILITY_TASK_INPUT,
    });
    expect(route.taskProfile.capabilitiesRequired).toEqual([]);
    expect(route.routingReason).toBe("tier_routing");
    expect(route.dynamicallySelected).toBe(true); // all 5 confirmed_working executors are real peers now
    expect([...route.executorCandidates].sort()).toEqual(
      ["antigravity_local", "claude_local", "codex_local", "hermes_local", "opencode_local"].sort(),
    );
    expect(route.selectedExecutor).toBe("codex_local");
    expect(route.selectedModel).toBe(DEFAULT_CODEX_LOCAL_MODEL);
  });

  it("an ordinary coding task also resolves dynamically to codex_local — its fileEditing/tools capability flags are verified true from documented ACP + a real completed live run, not just its CODING_AGENT_RUNTIME category label", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: BASE_TASK_PROFILE_INPUT,
    });
    expect(route.taskProfile.taskType).toBe("coding");
    expect(route.taskProfile.capabilitiesRequired.length).toBeGreaterThan(0);
    expect(route.routingReason).toBe("tier_routing");
    expect(route.selectedExecutor).toBe("codex_local");
    expect(route.selectedModel).toBe(DEFAULT_CODEX_LOCAL_MODEL);
  });

  it("fails closed (no_route_available) when a TaskProfile requires a capability no eligible executor can satisfy", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: { title: "Click through the browser checkout and take a screenshot" },
    });
    expect(route.taskProfile.capabilitiesRequired).toContain("browser");
    expect(route.routingReason).toBe("no_route_available");
    expect(route.selectedExecutor).toBeNull();
  });

  it("fails closed for a privacy=local_only task, even on codex_local — running as a local CLI process is not the same as a verified local_execution capability, and codex_local still calls a cloud API", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: { title: "Process this on-device, do not send to cloud" },
    });
    expect(route.taskProfile.privacyRequirement).toBe("local_only");
    expect(route.taskProfile.capabilitiesRequired).toContain("local_execution");
    expect(route.routingReason).toBe("no_route_available");
    expect(route.selectedExecutor).toBeNull();
  });

  it("paperclip_runner's alias to codex_local's registry rows is preserved in the fixed/pinned path", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "paperclip_runner",
      pinState: {},
      registryAdapterTypeOverride: "codex_local",
      taskProfileInput: BASE_TASK_PROFILE_INPUT,
    });
    expect(route.fixedRoutingReason).toBe("non_eligible_category");
    expect(route.routingReason).toBe("adapter_default_fallback");
    expect(route.selectedExecutor).toBe("paperclip_runner");
    expect(route.selectedModel).toBe(DEFAULT_CODEX_LOCAL_MODEL);
  });

  it("a claude_local-configured agent stays on claude_local by incumbency (now also confirmed_working in its own right, post-2026-10-03 promotion), preserving pre-existing behavior for already-configured agents", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "claude_local",
      humanModelTier: "T2",
      pinState: {},
      taskProfileInput: BASE_TASK_PROFILE_INPUT,
    });
    expect(route.routingReason).toBe("tier_routing");
    expect(route.dynamicallySelected).toBe(true); // both claude_local (own) and codex_local (peer) were real candidates
    expect(route.selectedExecutor).toBe("claude_local");
    expect(route.selectedModel).toBe("claude-sonnet-5");
    expect(route.executorCandidates).toContain("claude_local");
    expect(route.executorCandidates).toContain("codex_local");
  });
});

describe("scoreExecutionCandidate — deterministic scoring", () => {
  it("prefers the tier matching task difficulty over a mismatched tier", async () => {
    const profile = { difficultyTier: "T4", costPreference: "balanced" } as any;
    const t4: ExecutionCandidate = { executorType: "a", provider: "x", model: "m4", tier: "T4", reason: "tier_routing" };
    const t1: ExecutionCandidate = { executorType: "b", provider: "x", model: "m1", tier: "T1", reason: "tier_routing" };
    expect(scoreExecutionCandidate(t4, profile)).toBeGreaterThan(scoreExecutionCandidate(t1, profile));
  });

  it("cheapest cost preference favors a lower tier among equally-difficulty-distant candidates", async () => {
    const profile = { difficultyTier: "T2", costPreference: "cheapest" } as any;
    const t1: ExecutionCandidate = { executorType: "a", provider: "x", model: "m1", tier: "T1", reason: "tier_routing" };
    const t3: ExecutionCandidate = { executorType: "b", provider: "x", model: "m3", tier: "T3", reason: "tier_routing" };
    expect(scoreExecutionCandidate(t1, profile)).toBeGreaterThan(scoreExecutionCandidate(t3, profile));
  });

  it("2026-10-03 revision: incumbency is ONLY a final tie-break — it must NOT override a real tier/cost difference (reversed from the earlier dominant-bonus design, per explicit CEO instruction)", async () => {
    const profile = { difficultyTier: "T4", costPreference: "quality_first" } as any;
    const ownExecutorButWorseTier: ExecutionCandidate = { executorType: "incumbent", provider: "x", model: "m1", tier: "T1", reason: "tier_routing" };
    const betterTierButDifferentExecutor: ExecutionCandidate = { executorType: "other", provider: "x", model: "m4", tier: "T4", reason: "tier_routing" };
    // The incumbent's objectively worse tier fit now correctly LOSES.
    expect(scoreExecutionCandidate(ownExecutorButWorseTier, profile, "incumbent")).toBeLessThan(
      scoreExecutionCandidate(betterTierButDifferentExecutor, profile, "incumbent"),
    );
  });

  it("incumbency breaks an EXACT tie — same tier, same cost fit, no other distinguishing factor", async () => {
    const profile = { difficultyTier: "T2", costPreference: "balanced" } as any;
    const incumbent: ExecutionCandidate = { executorType: "incumbent", provider: "x", model: "m1", tier: "T2", reason: "tier_routing" };
    const other: ExecutionCandidate = { executorType: "other", provider: "x", model: "m2", tier: "T2", reason: "tier_routing" };
    expect(scoreExecutionCandidate(incumbent, profile, "incumbent")).toBeGreaterThan(
      scoreExecutionCandidate(other, profile, "incumbent"),
    );
  });
});

describe("classifyExecutionFailure / nextFallbackCandidate — bounded fallback (requirement #5)", () => {
  it("classifies the 8 documented retryable codes as retryable", async () => {
    for (const code of [
      "unsupported_model", "model_unavailable", "provider_unavailable", "executor_unavailable",
      "rate_limited", "quota_exceeded", "transient_provider_error", "transient_executor_error",
    ]) {
      expect(classifyExecutionFailure(code)).toBe("retryable");
    }
  });

  it("classifies the 6 documented non-retryable codes as non_retryable", async () => {
    for (const code of [
      "authentication_failure", "permission_failure", "policy_rejection",
      "unsafe_action", "malformed_request", "approval_gate_rejected",
    ]) {
      expect(classifyExecutionFailure(code)).toBe("non_retryable");
    }
  });

  it("fails closed (non_retryable) for an unknown or missing error code", async () => {
    expect(classifyExecutionFailure("something_never_seen_before")).toBe("non_retryable");
    expect(classifyExecutionFailure(null)).toBe("non_retryable");
    expect(classifyExecutionFailure(undefined)).toBe("non_retryable");
  });

  it("bounds fallback at exactly 2 attempts (3 total)", async () => {
    expect(MAX_FALLBACK_ATTEMPTS).toBe(2);
    const route: { fallbackChain: ExecutionCandidate[] } = {
      fallbackChain: [
        { executorType: "a", provider: "p", model: "m1", tier: "T2", reason: "tier_routing" },
        { executorType: "b", provider: "p", model: "m2", tier: "T2", reason: "tier_routing" },
      ],
    };
    expect(nextFallbackCandidate(route, 0)?.executorType).toBe("a");
    expect(nextFallbackCandidate(route, 1)?.executorType).toBe("b");
    expect(nextFallbackCandidate(route, 2)).toBeNull();
  });
});

// NEXORA Executor Registry Promotion (2026-10-03, two rounds) — task-profile
// eligibility matrix using the REAL registry (no test-only override): proves
// confirmed_working is NOT equated with automatically selectable, and that
// generic category-based task suitability (never a hardcoded vendor name)
// produces real, different executor selections per task type. codex_local,
// claude_local, antigravity_local, hermes_local, AND opencode_local are all
// confirmed_working as of this round. gemini_local remains unverified (its
// auth fix is blocked — see the batch report) and never enters an eligible
// set unless it is the agent's own pinned executor.
describe("resolveExecutionRoute — post-promotion task-profile eligibility matrix (real registry)", () => {
  it("A. general writing / no special capability -> ALL 5 confirmed_working executors are eligible; codex_local wins as the agent's own (a perfect multi-way tie on every other factor, broken only by incumbency)", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: { title: "Write a short release announcement", description: "A couple of sentences." },
    });
    expect(route.taskProfile.capabilitiesRequired).toEqual([]);
    expect([...route.executorCandidates].sort()).toEqual(
      ["antigravity_local", "claude_local", "codex_local", "hermes_local", "opencode_local"].sort(),
    );
    expect(route.executorCandidates).not.toContain("gemini_local");
    expect(route.selectedExecutor).toBe("codex_local"); // incumbency: the only differentiator left
  });

  it("B. coding -> all 5 satisfy the fileEditing capability gate now, but generic CODING_AGENT_RUNTIME category suitability (not a hardcoded vendor name) ranks codex_local/claude_local/opencode_local above antigravity_local/hermes_local — codex_local wins as the agent's own among its CODING_AGENT_RUNTIME peers", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: BASE_TASK_PROFILE_INPUT, // classifies as "coding"
    });
    expect(route.taskProfile.taskType).toBe("coding");
    expect([...route.executorCandidates].sort()).toEqual(
      ["antigravity_local", "claude_local", "codex_local", "hermes_local", "opencode_local"].sort(),
    );
    expect(route.selectedExecutor).toBe("codex_local");
    // The fallback chain's first (best-ranked) alternative must be another
    // CODING_AGENT_RUNTIME peer (claude_local), never an AUTONOMOUS_AGENT_
    // RUNTIME one (antigravity_local/hermes_local) — proving the generic
    // category-affinity scoring actually discriminates, without naming any
    // vendor in the scoring logic itself.
    expect(route.fallbackChain[0]?.executorType).toBe("claude_local");
  });

  it("C. research/tool-calling -> all 5 satisfy the tools capability gate; no category has a research affinity, so this is a perfect tie broken only by incumbency — claude_local wins here because THIS agent is configured on claude_local, proving the SAME unpinned JARVIS picks a different winner purely from task+config, not a fixed preference", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "claude_local",
      pinState: {},
      taskProfileInput: { title: "Research competitor pricing options", description: "Investigate and compare options." },
    });
    expect(route.taskProfile.taskType).toBe("research");
    expect(route.taskProfile.capabilitiesRequired).toEqual(["tool_calling"]);
    expect([...route.executorCandidates].sort()).toEqual(
      ["antigravity_local", "claude_local", "codex_local", "hermes_local", "opencode_local"].sort(),
    );
    expect(route.selectedExecutor).toBe("claude_local");
  });

  it("D. browser automation -> zero eligible executors (browser is unknown for every row, including the 3 newly promoted ones — fail-closed)", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: { title: "Click through the browser checkout and take a screenshot" },
    });
    expect(route.taskProfile.capabilitiesRequired).toContain("browser");
    expect(route.executorCandidates).toEqual([]);
    expect(route.routingReason).toBe("no_route_available");
    expect(route.selectedExecutor).toBeNull();
  });

  it("E. GUI automation -> zero eligible executors (gui is unknown for every row)", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: { title: "Interact with the desktop app window using the mouse" },
    });
    expect(route.taskProfile.capabilitiesRequired).toContain("gui");
    expect(route.executorCandidates).toEqual([]);
    expect(route.routingReason).toBe("no_route_available");
    expect(route.selectedExecutor).toBeNull();
  });

  it("F. local/private processing -> zero eligible executors (local_execution is unknown for every row, including isLocal:true ones — running locally is not the same as a verified local_execution capability)", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: { title: "Process this on-device, do not send to cloud" },
    });
    expect(route.taskProfile.privacyRequirement).toBe("local_only");
    expect(route.taskProfile.capabilitiesRequired).toContain("local_execution");
    expect(route.executorCandidates).toEqual([]);
    expect(route.routingReason).toBe("no_route_available");
    expect(route.selectedExecutor).toBeNull();
  });

  it("codex_local remains confirmed_working and selectable after the promotion (unaffected by other rows' changes)", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "codex_local",
      pinState: {},
      taskProfileInput: { title: "Write a short release announcement" },
    });
    expect(route.selectedExecutor).toBe("codex_local");
    expect(route.selectedModel).toBeTruthy();
  });

  it("2026-10-03 revision: an unverified incumbent (gemini_local) does NOT get a free pass anymore — an unpinned agent configured on it gets redirected to a real confirmed_working peer instead of silently staying put, exactly per the explicit CEO instruction reversing the earlier incumbency-always-included design", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "gemini_local",
      pinState: {},
      taskProfileInput: { title: "Write a short release announcement" },
    });
    expect(route.executorCandidates).not.toContain("gemini_local");
    expect(route.selectedExecutor).not.toBe("gemini_local");
    expect(route.selectedExecutor).not.toBeNull();
    expect(["codex_local", "claude_local", "antigravity_local", "hermes_local", "opencode_local"]).toContain(route.selectedExecutor);
  });

  it("explicit pin is still the full escape hatch even for an unverified executor: adapterPinned=true keeps a gemini_local-configured agent on gemini_local, bypassing the operational-state gate entirely", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "gemini_local",
      pinState: { adapterPinned: true },
      taskProfileInput: { title: "Write a short release announcement" },
    });
    expect(route.fixedRoutingReason).toBe("pinned");
    expect(route.selectedExecutor).toBe("gemini_local");
  });

  it("antigravity_local, hermes_local, and opencode_local now have a REAL, usable model candidate via the runtime_discovery bridge — each one's live-discovered (model, provider) actually reaches the scored candidate / fallback chain, not silently dropped the way it was before this round's integration", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: "antigravity_local",
      pinState: {},
      taskProfileInput: { title: "Write a short release announcement", description: "A couple of sentences." },
    });
    // antigravity_local is the agent's own executor here, so it wins via
    // incumbency on this perfectly-tied no-capability task — proving its
    // runtime-discovered candidate is real and dispatchable, not dropped.
    expect(route.selectedExecutor).toBe("antigravity_local");
    expect(route.selectedModel).toBe("gemini-3.8-flash-high");
    expect(route.selectedProvider).toBe("antigravity");
    expect(route.routingReason).toBe("runtime_discovery");
  });
});

// CEO-required CRITICAL PROOF (2026-10-03 batch): the SAME unpinned agent
// identity/configuration must select DIFFERENT executors for different
// TaskProfiles, driven by generic, evidence-backed executor metadata
// (category-based task-suitability + capability match) — never a hardcoded
// "coding -> Codex" / "research -> Claude" rule.
describe("resolveExecutionRoute — CRITICAL PROOF: same unpinned agent, different task, different executor", () => {
  const SAME_AGENT_ADAPTER_TYPE = "codex_local"; // identical agent config for both calls below

  it("for a plain coding task, the codex_local-configured agent stays on codex_local (its own CODING_AGENT_RUNTIME category gets the task-suitability bonus)", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: SAME_AGENT_ADAPTER_TYPE,
      pinState: {},
      taskProfileInput: BASE_TASK_PROFILE_INPUT, // classifies as "coding"
    });
    expect(route.taskProfile.taskType).toBe("coding");
    expect(route.selectedExecutor).toBe("codex_local");
  });

  it("for a tool-execution-flavored task, the SAME codex_local-configured agent gets redirected to antigravity_local — an AUTONOMOUS_AGENT_RUNTIME peer whose category now gets the task-suitability bonus instead, decisively outscoring codex_local's own incumbency — proving the executor choice genuinely changed with the task, not the agent config", async () => {
    const route = await resolveExecutionRoute({
      agentAdapterType: SAME_AGENT_ADAPTER_TYPE,
      pinState: {},
      taskProfileInput: { title: "Invoke tool to call api endpoint", description: "A short automation step." },
    });
    expect(route.taskProfile.taskType).toBe("tool_execution");
    expect(route.selectedExecutor).toBe("antigravity_local");
    expect(route.selectedExecutor).not.toBe("codex_local");
    expect(route.selectedProvider).toBe("antigravity");
    expect(route.routingReason).toBe("runtime_discovery");
  });
});
