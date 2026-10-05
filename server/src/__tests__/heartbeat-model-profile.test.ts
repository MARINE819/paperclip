import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveModelProfileApplication,
  resolveEffectiveModelSelection,
  isConfigurationIncompleteFailedRun,
} from "../services/heartbeat.ts";

const cheapProfile: AdapterModelProfileDefinition = {
  key: "cheap",
  label: "Cheap",
  adapterConfig: {
    model: "adapter-cheap",
    modelReasoningEffort: "low",
  },
  source: "adapter_default",
};

describe("heartbeat model profile application", () => {
  it("keeps Codex on its primary model when cheap has no explicit model override", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("codex_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "primary" },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
      adapterConfig: {},
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("applies cheap profile patches before explicit issue adapter config overrides", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
        modelReasoningEffort: "high",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "issue-explicit",
      },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
    });
    expect(merged).toEqual({
      model: "issue-explicit",
      modelReasoningEffort: "low",
      approvalPolicy: "strict",
    });
  });

  it("lets agent runtime profile config customize adapter defaults", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
      adapterConfig: {
        model: "agent-cheap",
        modelReasoningEffort: "low",
      },
    });
  });

  it("falls back to the primary config when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });

  it("treats model resolution failures as non-retryable configuration failures", () => {
    expect(isConfigurationIncompleteFailedRun({ errorCode: "model_not_found" })).toBe(true);
    expect(isConfigurationIncompleteFailedRun({ errorCode: "provider_quota" })).toBe(false);
  });
});

describe("resolveEffectiveModelSelection (NEXORA Stage 7 tier routing wiring)", () => {
  it("keeps an explicit agent runtimeConfig.model and its own adapterType even when a tier is also requested", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: "claude-opus-4-8",
      agentAdapterType: "claude_local",
      modelTier: "T1",
    });
    expect(result.reason).toBe("agent_explicit_override");
    expect(result.model).toBe("claude-opus-4-8");
    expect(result.adapterType).toBe("claude_local");
  });

  it("preserves an explicit model unknown to the registry without guessing its adapter", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: "non-registry-custom-model",
      agentAdapterType: "codex_local",
      modelTier: null,
    });
    expect(result.reason).toBe("agent_explicit_override");
    expect(result.model).toBe("non-registry-custom-model");
    expect(result.adapterType).toBe("codex_local");
  });

  it("routes T1 to an enabled codex_local T1 registry model, never a different adapter's model", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: null,
      agentAdapterType: "codex_local",
      modelTier: "T1",
    });
    expect(result.reason).toBe("tier_routing");
    expect(result.tier).toBe("T1");
    expect(result.adapterType).toBe("codex_local");
  });

  it("routes T2 to an enabled claude_local T2 registry model, never a different adapter's model", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: undefined,
      agentAdapterType: "claude_local",
      modelTier: "T2",
    });
    expect(result.reason).toBe("tier_routing");
    expect(result.tier).toBe("T2");
    expect(result.adapterType).toBe("claude_local");
  });

  it("routes T3 to an enabled claude_local T3 registry model, never a different adapter's model", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: "",
      agentAdapterType: "claude_local",
      modelTier: "T3",
    });
    expect(result.reason).toBe("tier_routing");
    expect(result.tier).toBe("T3");
    expect(result.adapterType).toBe("claude_local");
  });

  it("falls back to gemini_local's own default (never Claude/Codex) when gemini has no T3 candidate", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: null,
      agentAdapterType: "gemini_local",
      modelTier: "T3",
    });
    expect(result.reason).toBe("adapter_default_fallback");
    expect(result.adapterType).toBe("gemini_local");
    expect(result.model).toBe("gemini-2.0-flash-lite");
  });

  it("falls back to the agent's own adapter default when neither an explicit model nor a tier is configured", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: null,
      agentAdapterType: "claude_local",
      modelTier: null,
    });
    expect(result.reason).toBe("adapter_default_fallback");
    expect(result.adapterType).toBe("claude_local");
    expect(typeof result.model).toBe("string");
    expect(result.model?.length ?? 0).toBeGreaterThan(0);
  });

  it("fails closed with no_route_available for an adapterType absent from the registry, never substituting another provider", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: null,
      agentAdapterType: "grok",
      modelTier: "T2",
    });
    expect(result.reason).toBe("no_route_available");
    expect(result.model).toBeNull();
  });

  it("aliases paperclip_runner + provider=codex to codex_local registry rows but keeps paperclip_runner as the reported adapterType", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: null,
      agentAdapterType: "paperclip_runner",
      modelTier: "T2",
      effectiveAdapterConfigProvider: "codex",
    });
    expect(result.reason).toBe("tier_routing");
    expect(result.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(result.adapterType).toBe("paperclip_runner");
    expect(result.adapterType).not.toBe("codex_local");
  });

  it("does not alias paperclip_runner to codex_local when provider is not codex, and stays fail-closed", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: null,
      agentAdapterType: "paperclip_runner",
      modelTier: "T2",
      effectiveAdapterConfigProvider: "gemini",
    });
    expect(result.reason).toBe("no_route_available");
    expect(result.model).toBeNull();
    expect(result.adapterType).toBe("paperclip_runner");
  });

  it("defaults paperclip_runner's alias provider to codex when effectiveAdapterConfigProvider is omitted, matching runtime-mode.ts's own default", () => {
    const result = resolveEffectiveModelSelection({
      runtimeConfigModel: null,
      agentAdapterType: "paperclip_runner",
      modelTier: null,
    });
    expect(result.reason).toBe("adapter_default_fallback");
    expect(result.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(result.adapterType).toBe("paperclip_runner");
  });
});
