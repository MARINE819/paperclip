import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { getModelRegistry } from "./model-registry.js";
import { resolveRoutedModel } from "./model-router.js";

const TIER_MATRIX: Array<{
  adapterType: string;
  tier: "T1" | "T2" | "T3" | "T4";
  expectedReason: "tier_routing" | "adapter_default_fallback";
}> = [
  { adapterType: "codex_local", tier: "T1", expectedReason: "tier_routing" },
  { adapterType: "codex_local", tier: "T2", expectedReason: "tier_routing" },
  { adapterType: "codex_local", tier: "T3", expectedReason: "tier_routing" },
  { adapterType: "codex_local", tier: "T4", expectedReason: "adapter_default_fallback" },
  { adapterType: "claude_local", tier: "T1", expectedReason: "adapter_default_fallback" },
  { adapterType: "claude_local", tier: "T2", expectedReason: "tier_routing" },
  { adapterType: "claude_local", tier: "T3", expectedReason: "tier_routing" },
  { adapterType: "claude_local", tier: "T4", expectedReason: "tier_routing" },
  { adapterType: "gemini_local", tier: "T1", expectedReason: "tier_routing" },
  { adapterType: "gemini_local", tier: "T2", expectedReason: "adapter_default_fallback" },
  { adapterType: "gemini_local", tier: "T3", expectedReason: "adapter_default_fallback" },
  { adapterType: "gemini_local", tier: "T4", expectedReason: "adapter_default_fallback" },
];

describe("resolveRoutedModel — same-adapter tier/fallback matrix", () => {
  it.each(TIER_MATRIX)(
    "$adapterType requesting $tier never returns a cross-adapter model",
    ({ adapterType, tier, expectedReason }) => {
      const result = resolveRoutedModel({ agentAdapterType: adapterType, tierInput: tier });
      expect(result.reason).toBe(expectedReason);
      expect(result.adapterType).toBe(adapterType);
      expect(result.model).not.toBeNull();
      const record = getModelRegistry().find((m) => m.model === result.model);
      expect(record).toBeDefined();
      expect(record?.adapterType).toBe(adapterType);
      expect(record?.enabled).toBe(true);
    },
  );

  it("never selects a disabled model, even when it is registered ahead of enabled candidates for the same tier and adapter", () => {
    // T3's claude_local registry order is [claude-t3-legacy(disabled), claude-t3].
    const disabledT3Claude = getModelRegistry().find(
      (m) => m.tier === "T3" && m.adapterType === "claude_local" && !m.enabled,
    );
    expect(disabledT3Claude).toBeDefined();

    const result = resolveRoutedModel({ agentAdapterType: "claude_local", tierInput: "T3" });
    expect(result.model).not.toBe(disabledT3Claude?.model);
    expect(result.adapterType).toBe("claude_local");
  });
});

describe("resolveRoutedModel — explicit override", () => {
  it("preserves an explicit registry-known model and its own adapterType", () => {
    const result = resolveRoutedModel({
      agentRuntimeConfigModel: "gpt-5-mini",
      agentAdapterType: "codex_local",
      tierInput: "T4",
    });
    expect(result.reason).toBe("agent_explicit_override");
    expect(result.model).toBe("gpt-5-mini");
    expect(result.adapterType).toBe("codex_local");
  });

  it("preserves an explicit model string not found in the registry without guessing its adapter", () => {
    const result = resolveRoutedModel({
      agentRuntimeConfigModel: "non-registry-custom-model",
      agentAdapterType: "codex_local",
      tierInput: "T4",
    });
    expect(result.reason).toBe("agent_explicit_override");
    expect(result.model).toBe("non-registry-custom-model");
    expect(result.adapterType).toBe("codex_local");
  });

  it("never substitutes a different adapter's model even if the explicit string happens to match one in the registry under another adapter", () => {
    // "claude-sonnet-5" is a real registry entry, but under claude_local, not
    // codex_local. A codex_local agent's explicit override must still report
    // adapterType=codex_local, never claude_local inferred from the lookup.
    const result = resolveRoutedModel({
      agentRuntimeConfigModel: "claude-sonnet-5",
      agentAdapterType: "codex_local",
      tierInput: null,
    });
    expect(result.reason).toBe("agent_explicit_override");
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.adapterType).toBe("codex_local");
  });
});

describe("resolveRoutedModel — registryAdapterType lookup alias (paperclip_runner -> codex_local)", () => {
  it("routes a paperclip_runner tier request through codex_local registry rows but reports paperclip_runner as adapterType", () => {
    const result = resolveRoutedModel({
      agentAdapterType: "paperclip_runner",
      registryAdapterType: "codex_local",
      tierInput: "T2",
    });
    expect(result.reason).toBe("tier_routing");
    expect(result.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(result.adapterType).toBe("paperclip_runner");
    expect(result.adapterType).not.toBe("codex_local");
  });

  it("falls back to codex_local's default via alias but still reports paperclip_runner as adapterType", () => {
    const result = resolveRoutedModel({
      agentAdapterType: "paperclip_runner",
      registryAdapterType: "codex_local",
      tierInput: "T4",
    });
    expect(result.reason).toBe("adapter_default_fallback");
    expect(result.model).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(result.adapterType).toBe("paperclip_runner");
  });

  it("fails closed for paperclip_runner with no registryAdapterType alias supplied (non-codex provider case)", () => {
    const result = resolveRoutedModel({
      agentAdapterType: "paperclip_runner",
      tierInput: "T2",
    });
    expect(result.reason).toBe("no_route_available");
    expect(result.model).toBeNull();
    expect(result.adapterType).toBe("paperclip_runner");
  });

  it("leaves the existing same-adapter matrix behavior byte-identical when registryAdapterType is omitted", () => {
    for (const { adapterType, tier, expectedReason } of TIER_MATRIX) {
      const withoutAlias = resolveRoutedModel({ agentAdapterType: adapterType, tierInput: tier });
      const withRedundantAlias = resolveRoutedModel({
        agentAdapterType: adapterType,
        registryAdapterType: adapterType,
        tierInput: tier,
      });
      expect(withRedundantAlias).toEqual(withoutAlias);
      expect(withoutAlias.reason).toBe(expectedReason);
    }
  });
});

describe("resolveRoutedModel — unknown adapter fail-closed", () => {
  it("returns no_route_available with a null model for an adapter absent from the registry", () => {
    const result = resolveRoutedModel({ agentAdapterType: "grok", tierInput: "T2" });
    expect(result.reason).toBe("no_route_available");
    expect(result.model).toBeNull();
    expect(result.provider).toBeNull();
  });

  it("returns no_route_available when no adapterType is known at all", () => {
    const result = resolveRoutedModel({ agentAdapterType: null, tierInput: "T2" });
    expect(result.reason).toBe("no_route_available");
    expect(result.model).toBeNull();
  });
});
