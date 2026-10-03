// NEXORA Stage 7 v0.1 — Model Router (pure logic, no heartbeat/runtime wiring).
// Hard invariant: the router never changes an agent's adapter. Every model
// it returns for tier_routing or adapter_default_fallback belongs to the
// same agentAdapterType that was asked for. Cross-adapter / cross-provider
// failover is explicitly out of scope for v0.1 — an adapterType with no
// registry coverage fails closed (no_route_available) rather than
// substituting a different adapter's model.

import {
  type ModelRecord,
  type ModelTier,
  findModelByModelString,
  getDefaultModel,
  getEnabledModelsForTier,
} from "./model-registry.js";

export type RoutingReason =
  | "agent_explicit_override"
  | "tier_routing"
  | "adapter_default_fallback"
  | "no_route_available";

export interface RouteModelInput {
  agentRuntimeConfigModel?: string | null;
  agentAdapterType?: string | null;
  // Registry lookup-only alias target (e.g. paperclip_runner -> codex_local).
  // Never influences the returned adapterType, which always reports
  // agentAdapterType — this field only redirects which adapter's registry
  // rows tier_routing/adapter_default_fallback are allowed to read from.
  registryAdapterType?: string | null;
  tierInput?: ModelTier | null;
}

export interface RouteModelResult {
  model: string | null;
  provider: string | null;
  adapterType: string | null;
  tier: ModelTier | null;
  reason: RoutingReason;
}

function resultFromRecord(
  record: ModelRecord,
  reason: RoutingReason,
  resultAdapterType: string,
): RouteModelResult {
  return {
    model: record.model,
    provider: record.provider,
    // Always the caller's own agentAdapterType, never the registry alias
    // used to look this record up — execution identity must never change.
    adapterType: resultAdapterType,
    tier: record.tier,
    reason,
  };
}

export function resolveRoutedModel(input: RouteModelInput): RouteModelResult {
  const explicitModel = input.agentRuntimeConfigModel?.trim();
  if (explicitModel) {
    // Legacy-compatible path: an agent's own configured model is trusted and
    // preserved as-is. The router never infers or rewrites the adapterType
    // from the model string or from a registry lookup here — it always
    // reports the agent's own already-known adapterType, matching how this
    // value was already being used before Stage 7 introduced tier routing.
    return {
      model: explicitModel,
      provider: findModelByModelString(explicitModel)?.provider ?? "unknown",
      adapterType: input.agentAdapterType ?? "unknown",
      tier: null,
      reason: "agent_explicit_override",
    };
  }

  const adapterType = input.agentAdapterType;
  if (!adapterType) {
    return { model: null, provider: null, adapterType: null, tier: null, reason: "no_route_available" };
  }
  const registryAdapterType = input.registryAdapterType ?? adapterType;

  if (input.tierInput) {
    const candidates = getEnabledModelsForTier(input.tierInput, registryAdapterType);
    if (candidates.length > 0) {
      return resultFromRecord(candidates[0]!, "tier_routing", adapterType);
    }
  }

  const fallback = getDefaultModel(registryAdapterType);
  if (fallback) {
    return resultFromRecord(fallback, "adapter_default_fallback", adapterType);
  }

  return { model: null, provider: null, adapterType, tier: null, reason: "no_route_available" };
}
