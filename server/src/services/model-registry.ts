// NEXORA Stage 7 v0.1 — Model Registry.
// Code-constant registry (no DB table, no migration) mirroring how
// adapters/registry.ts already tracks each adapter's model list. This is
// intentionally a curated subset for tier-based routing, not an exhaustive
// whitelist of every model an adapter can run — an agent's own explicit
// runtimeConfig.model is honored by the router even if it isn't listed here.

import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";

export type ModelTier = "T1" | "T2" | "T3" | "T4";
export type ModelCostClass = "free" | "low" | "mid" | "high" | "highest";

export interface ModelRecord {
  id: string;
  provider: string;
  adapterType: string;
  model: string;
  tier: ModelTier;
  costClass: ModelCostClass;
  enabled: boolean;
}

const MODEL_REGISTRY: readonly ModelRecord[] = [
  { id: "gemini-t1", provider: "google", adapterType: "gemini_local", model: "gemini-2.0-flash-lite", tier: "T1", costClass: "free", enabled: true },
  { id: "codex-t1", provider: "openai", adapterType: "codex_local", model: "gpt-5-mini", tier: "T1", costClass: "low", enabled: true },
  // Reuses the codex-local adapter package's own authoritative default model
  // constant instead of a second hardcoded literal — this is the single
  // source of truth fix for the stale "gpt-5" default that caused a real
  // Pilot HTTP 400 (that legacy slug is no longer the adapter's current
  // default; see packages/adapters/codex-local/src/index.ts's own comment on
  // why bare/legacy slugs break). A future adapter default change can never
  // silently re-diverge from this registry again.
  { id: "codex-t2", provider: "openai", adapterType: "codex_local", model: DEFAULT_CODEX_LOCAL_MODEL, tier: "T2", costClass: "mid", enabled: true },
  { id: "claude-t2", provider: "anthropic", adapterType: "claude_local", model: "claude-sonnet-5", tier: "T2", costClass: "mid", enabled: true },
  { id: "claude-t3-legacy", provider: "anthropic", adapterType: "claude_local", model: "claude-opus-4-6", tier: "T3", costClass: "high", enabled: false },
  { id: "claude-t3", provider: "anthropic", adapterType: "claude_local", model: "claude-opus-5", tier: "T3", costClass: "high", enabled: true },
  { id: "codex-t3", provider: "openai", adapterType: "codex_local", model: "gpt-5.4", tier: "T3", costClass: "high", enabled: true },
  { id: "claude-t4", provider: "anthropic", adapterType: "claude_local", model: "claude-opus-4-8", tier: "T4", costClass: "highest", enabled: true },
];

// The router must never hardcode a vendor-specific fallback string; it
// resolves each adapter's default by looking these ids up in the registry.
// One entry per adapterType this registry has any coverage for at all — an
// adapterType absent from this map has no route (fail-closed), never a
// cross-adapter substitute.
const DEFAULT_MODEL_ID_BY_ADAPTER: Readonly<Record<string, string>> = {
  codex_local: "codex-t2",
  claude_local: "claude-t2",
  gemini_local: "gemini-t1",
};

export function getModelRegistry(): readonly ModelRecord[] {
  return MODEL_REGISTRY;
}

export function getModelById(id: string): ModelRecord | null {
  return MODEL_REGISTRY.find((m) => m.id === id) ?? null;
}

export function findModelByModelString(model: string): ModelRecord | null {
  return MODEL_REGISTRY.find((m) => m.model === model) ?? null;
}

export function getEnabledModelsForTier(tier: ModelTier, adapterType: string): ModelRecord[] {
  return MODEL_REGISTRY.filter((m) => m.tier === tier && m.enabled && m.adapterType === adapterType);
}

export function getDefaultModel(adapterType: string): ModelRecord | null {
  const id = DEFAULT_MODEL_ID_BY_ADAPTER[adapterType];
  if (!id) return null;
  const record = getModelById(id);
  return record && record.enabled && record.adapterType === adapterType ? record : null;
}
