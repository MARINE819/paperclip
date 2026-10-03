// NEXORA Intelligent Execution Router — Executor Registry.
// Code-constant registry (no DB table, no migration), sitting ABOVE
// model-registry.ts the same way model-registry.ts sits above raw adapter
// execution. model-registry.ts still owns provider/model/tier data for the
// executors that host interchangeable models; this registry adds the
// category/capability/operational-status layer needed to pick WHICH
// executor runs a task, not just which model.
//
// Every field below is seeded from a direct, file-cited read-only audit of
// server/src/adapters/registry.ts, each packages/adapters/* package, and
// docs/investigations/*.md (2026-10-03) — never invented. Where the audit
// found no evidence for a capability or operational fact, the field is set
// to "unknown" (capabilities) or "unverified" (operationalStatus), never
// guessed as true/working. See docs/investigations for the full citations.
//
// DISCOVERED != ENABLED. INSTALLED != VERIFIED. VERIFIED != AUTOMATICALLY
// SELECTED. Only operationalStatus === "confirmed_working" AND enabled
// AND a full capability match may enter a dynamic routing candidate pool
// (enforced in execution-router.ts, not here).

import type { ModelCostClass } from "./model-registry.js";
import type { CapabilityRequirement } from "./task-profile-classifier.js";

export type ExecutorCategory =
  | "GENERAL_LLM_PROVIDER"
  | "CODING_AGENT_RUNTIME"
  | "AUTONOMOUS_AGENT_RUNTIME"
  | "LOCAL_MODEL_RUNTIME"
  | "ORCHESTRATION_MULTI_AGENT_RUNTIME"
  | "TOOL_EXECUTION_ONLY"
  | "GATEWAY_META_PROVIDER";

export type OperationalStatus = "confirmed_working" | "unverified" | "confirmed_broken" | "retired";
export type HealthStatus = "healthy" | "degraded" | "unknown";
export type ExecutorSourceType = "builtin" | "local_github" | "plugin" | "external_service";
export type SpeedClass = "fast" | "standard" | "slow";
// STATIC_REGISTRY: model/tier comes from model-registry.ts's fixed MODEL_REGISTRY
// rows (codex_local, claude_local, gemini_local, etc.) — unchanged F-09 design.
// RUNTIME_DISCOVERY: model/provider is genuinely pluggable per-instance and has
// no fixed registry row; execution-router.ts queries the executor's own CLI
// live (via runtime-model-discovery.ts) instead. Never force a
// RUNTIME_DISCOVERY executor into a fake static row just to make it
// selectable.
export type ModelSourceType = "static_registry" | "runtime_discovery";

export interface ExecutorCapabilityFlags {
  tools: boolean | "unknown";
  browser: boolean | "unknown";
  terminal: boolean | "unknown";
  gui: boolean | "unknown";
  fileEditing: boolean | "unknown";
  localExecution: boolean | "unknown";
  multiAgent: boolean | "unknown";
}

export interface ExecutorRecord {
  executorId: string;
  executorType: string; // matches adapterType for every builtin row today
  category: ExecutorCategory;
  adapterType: string;
  provider: string | null;
  enabled: boolean;
  operationalStatus: OperationalStatus;
  capabilities: ExecutorCapabilityFlags;
  supportsModels: boolean;
  modelSourceType: ModelSourceType;
  isLocal: boolean;
  costClass: ModelCostClass;
  speedClass: SpeedClass;
  maxContextTokens: number | null;
  healthStatus: HealthStatus;
  lastVerifiedAt: string | null;
  sourceType: ExecutorSourceType;
  // local_github sourceType only — null for every row today (nothing of that
  // kind is installed in this environment; schema-ready, not populated).
  repository: string | null;
  installPath: string | null;
  version: string | null;
  binaryPath: string | null;
  launchCommandReference: string | null;
  healthCheckStrategy: string | null;
}

const UNKNOWN_CAPABILITIES: ExecutorCapabilityFlags = {
  tools: "unknown",
  browser: "unknown",
  terminal: "unknown",
  gui: "unknown",
  fileEditing: "unknown",
  localExecution: "unknown",
  multiAgent: "unknown",
};

function builtinExecutor(partial: Omit<ExecutorRecord,
  | "sourceType" | "repository" | "installPath" | "version" | "binaryPath"
  | "launchCommandReference" | "healthCheckStrategy" | "capabilities" | "modelSourceType"
> & { capabilities?: Partial<ExecutorCapabilityFlags>; modelSourceType?: ModelSourceType; binaryPath?: string | null }): ExecutorRecord {
  return {
    ...partial,
    capabilities: { ...UNKNOWN_CAPABILITIES, ...partial.capabilities },
    modelSourceType: partial.modelSourceType ?? "static_registry",
    sourceType: "builtin",
    repository: null,
    installPath: null,
    version: null,
    binaryPath: partial.binaryPath ?? null,
    launchCommandReference: null,
    healthCheckStrategy: null,
  };
}

// Classification citations (file:line, audited 2026-10-03):
// - codex_local: confirmed live run, exit 0 — docs/investigations/highest-remaining-blocker.md:5,15
// - paperclip_runner: generic execute() unconditionally fails — server/src/adapters/registry.ts:354-365
//   (real production usage of this adapterType instead goes through the separate
//   native-runner-coordinator dispatch path in heartbeat.ts, which bypasses this
//   stub entirely — this row describes the generic adapter.execute() path only)
// - acpx_local: retired tombstone, always fails — server/src/adapters/registry.ts:280-312
// - cursor_cloud: cloud SDK (@cursor/sdk), models: [] — registry.ts:423
// - hermes_local: "supports any model via any provider" (pluggable, no fixed provider),
//   "30+ native tools" — package index.ts:1-10,40-47
// - process/http: generic wrappers, models: [] — process/index.ts:9, http/index.ts:9
// Everything else: no documented live-run evidence found either way —
// operationalStatus is honestly "unverified", not assumed working.
//
// Capability flags: every CODING_AGENT_RUNTIME row below has tools/fileEditing/
// terminal set true specifically because each one's own package documents ACP
// (Agent Client Protocol — a file-edit/tool-execution protocol by definition)
// and/or an explicit tool list (e.g. pi-local's own doc: "read, bash, edit,
// write, grep, find, ls enabled by default"), cited per-row below — this is a
// grounded reading of real package documentation, not an invented claim.
// browser/gui/localExecution/multiAgent stay "unknown" everywhere: the audit
// found zero evidence for any of them on any executor.
const EXECUTOR_REGISTRY: readonly ExecutorRecord[] = [
  builtinExecutor({
    executorId: "exec-codex-local", executorType: "codex_local", category: "CODING_AGENT_RUNTIME",
    adapterType: "codex_local", provider: "openai", enabled: true, operationalStatus: "confirmed_working",
    // ACP + fast-mode model table (packages/adapters/codex-local/src/index.ts) plus a
    // documented real completed run doing tool-driven reads against live issues
    // (docs/investigations/highest-remaining-blocker.md:5,15) — tool/file/terminal
    // capability is directly demonstrated, not inferred from category alone.
    capabilities: { tools: true, fileEditing: true, terminal: true },
    supportsModels: true, isLocal: true, costClass: "mid", speedClass: "standard",
    maxContextTokens: null, healthStatus: "healthy", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-claude-local", executorType: "claude_local", category: "CODING_AGENT_RUNTIME",
    adapterType: "claude_local", provider: "anthropic", enabled: true, operationalStatus: "confirmed_working",
    // ACP engine + instructions bundle + skills + filesystemScope/networkScope
    // sandboxing (packages/adapters/claude-local/src/index.ts:53-57).
    // Operationally verified 2026-10-03: real `claude -p "Return exactly:
    // NEXORA_EXECUTOR_OK"` CLI invocation, exact response match, is_error:false,
    // model claude-sonnet-5, provider "firstParty" (anthropic).
    capabilities: { tools: true, fileEditing: true, terminal: true },
    supportsModels: true, isLocal: true, costClass: "mid", speedClass: "standard",
    maxContextTokens: null, healthStatus: "healthy", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-gemini-local", executorType: "gemini_local", category: "CODING_AGENT_RUNTIME",
    adapterType: "gemini_local", provider: "google", enabled: true, operationalStatus: "unverified",
    // ACP + CLI fallback + sandbox flag + skills (packages/adapters/gemini-local/src/index.ts:36-64).
    capabilities: { tools: true, fileEditing: true, terminal: true },
    supportsModels: true, isLocal: true, costClass: "free", speedClass: "standard",
    maxContextTokens: null, healthStatus: "unknown", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-cursor", executorType: "cursor", category: "CODING_AGENT_RUNTIME",
    adapterType: "cursor", provider: null, enabled: true, operationalStatus: "unverified",
    // CLI harness wrapping Cursor's own coding agent (packages/adapters/cursor-local/src/index.ts:17-57).
    capabilities: { tools: true, fileEditing: true, terminal: true },
    supportsModels: true, isLocal: true, costClass: "mid", speedClass: "standard",
    maxContextTokens: null, healthStatus: "unknown", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-cursor-cloud", executorType: "cursor_cloud", category: "CODING_AGENT_RUNTIME",
    adapterType: "cursor_cloud", provider: null, enabled: true, operationalStatus: "unverified",
    supportsModels: false, isLocal: false, costClass: "mid", speedClass: "standard",
    maxContextTokens: null, healthStatus: "unknown", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-grok-local", executorType: "grok_local", category: "CODING_AGENT_RUNTIME",
    adapterType: "grok_local", provider: "xai", enabled: true, operationalStatus: "unverified",
    // Resumable sessions + Agents.md/.claude/skills discovery (packages/adapters/grok-local/src/index.ts:10-44).
    capabilities: { tools: true, fileEditing: true, terminal: true },
    supportsModels: true, isLocal: true, costClass: "mid", speedClass: "standard",
    maxContextTokens: null, healthStatus: "unknown", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-kimi-local", executorType: "kimi_local", category: "CODING_AGENT_RUNTIME",
    adapterType: "kimi_local", provider: "moonshot", enabled: true, operationalStatus: "unverified",
    // Effort-tier mapping + ACP support (packages/adapters/kimi-local/src/index.ts:16-47).
    capabilities: { tools: true, fileEditing: true, terminal: true },
    supportsModels: true, isLocal: true, costClass: "mid", speedClass: "standard",
    maxContextTokens: null, healthStatus: "unknown", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-pi-local", executorType: "pi_local", category: "CODING_AGENT_RUNTIME",
    adapterType: "pi_local", provider: null, enabled: true, operationalStatus: "unverified",
    // Explicit fixed tool list documented on the package itself: "(read, bash,
    // edit, write, grep, find, ls) enabled by default" (packages/adapters/pi-local).
    capabilities: { tools: true, fileEditing: true, terminal: true },
    supportsModels: false, isLocal: true, costClass: "mid", speedClass: "standard",
    maxContextTokens: null, healthStatus: "unknown", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-opencode-local", executorType: "opencode_local", category: "CODING_AGENT_RUNTIME",
    adapterType: "opencode_local", provider: null, enabled: true, operationalStatus: "confirmed_working",
    // Multi-provider coding CLI, Ollama-aware model listing (packages/adapters/opencode-local/src/index.ts:49-64).
    // Operationally verified 2026-10-03: installed via the official installer
    // (curl -fsSL https://opencode.ai/install | bash — inspected read-only
    // before execution), zero auth/account needed (its own free-tier
    // "opencode/" model namespace), `opencode run "Return exactly:
    // NEXORA_EXECUTOR_OK" --model opencode/big-pickle` succeeded with an exact
    // match. Combined capability probe (run from within a scratch cwd):
    // terminal (echo, ground-truth matched), file_read (ground-truth matched),
    // file_editing (ground-truth verified on disk afterward) all CONFIRMED
    // true. browser/gui/local_execution never exercised — stay unknown.
    // modelSourceType is runtime_discovery: `opencode models` returns a live,
    // real "<provider>/<model>" list (including its own free tier today) —
    // no fixed MODEL_REGISTRY row invented.
    // binaryPath (2026-10-03 production-readiness audit): the official
    // installer puts the binary at `$HOME/.opencode/bin/opencode(.exe)` and
    // only wires it onto PATH via an interactive-shell rc file, which Task
    // Scheduler-launched processes do not source — confirmed by direct
    // read-only check: bare `opencode` fails to resolve from the same
    // Machine/User PATH the production process inherits, while the full path
    // runs correctly (`opencode --version` -> succeeds). Routing (both this
    // registry's runtime-discovery candidate-building in execution-router.ts
    // and heartbeat.ts's dispatch config) reads this field and falls back to
    // the bare command when it's null, exactly like every other executor
    // here — this is the schema-ready "machine-local executable path field"
    // documented on ExecutorRecord, not a new mechanism. Update or clear this
    // value if the binary is reinstalled elsewhere or PATH is fixed globally.
    binaryPath: "C:\\Users\\Nexora\\.opencode\\bin\\opencode.exe",
    capabilities: { tools: true, fileEditing: true, terminal: true },
    supportsModels: true, modelSourceType: "runtime_discovery", isLocal: true, costClass: "free", speedClass: "standard",
    maxContextTokens: null, healthStatus: "healthy", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-antigravity-local", executorType: "antigravity_local", category: "AUTONOMOUS_AGENT_RUNTIME",
    adapterType: "antigravity_local", provider: null, enabled: true, operationalStatus: "confirmed_working",
    // Operationally verified 2026-10-03: `agy models` fetched a live model list
    // from its own hosted backend, then `agy --print "Return exactly:
    // NEXORA_EXECUTOR_OK"` succeeded (status:"SUCCESS", exact response match).
    // Combined capability probe (scoped via --add-dir to a disposable scratch
    // dir): file_read and file_editing CONFIRMED true (ground-truth verified
    // on disk). terminal/RunCommand is unconditionally auto-denied in
    // headless/--print mode by antigravity's own permission system (confirmed
    // directly: "a tool required the 'command' permission that headless mode
    // cannot prompt for") — not a capability gap, an environment constraint;
    // stays unknown rather than guessed either way. browser/gui/
    // local_execution never exercised — stay unknown.
    // modelSourceType is runtime_discovery: `agy models` returns a live,
    // real model list (14 entries confirmed) — no fixed MODEL_REGISTRY row
    // invented; dispatch passes an explicit --model, never "auto".
    capabilities: { tools: true, fileEditing: true },
    supportsModels: true, modelSourceType: "runtime_discovery", isLocal: true, costClass: "mid", speedClass: "standard",
    maxContextTokens: null, healthStatus: "healthy", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-hermes-local", executorType: "hermes_local", category: "AUTONOMOUS_AGENT_RUNTIME",
    adapterType: "hermes_local", provider: null, enabled: true, operationalStatus: "confirmed_working",
    // Operationally verified 2026-10-03: `hermes status` confirmed real
    // configured auth (OpenRouter + Google API keys, Nous Portal logged in),
    // then `hermes -z "Return exactly: NEXORA_EXECUTOR_OK"` returned the exact
    // string with no error. Combined capability probe: terminal (echo,
    // ground-truth matched), file_read (ground-truth matched), file_editing
    // (ground-truth verified on disk afterward) all CONFIRMED true — hermes's
    // own default tool-approval policy allowed all three without any
    // permission-bypass flag. browser/gui/local_execution never exercised —
    // stay unknown.
    // modelSourceType is runtime_discovery: Model is
    // nvidia/nemotron-3-super-120b-a12b (free tier) via a custom/OpenRouter
    // endpoint — genuinely pluggable, read live from `hermes status` at
    // dispatch time, never a fixed MODEL_REGISTRY row. supportsModels is now
    // true: this executor DOES support models, just via runtime discovery
    // rather than the static registry — the two are no longer conflated.
    capabilities: { tools: true, fileEditing: true, terminal: true },
    supportsModels: true, modelSourceType: "runtime_discovery", isLocal: true, costClass: "mid", speedClass: "standard",
    maxContextTokens: null, healthStatus: "healthy", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-hermes-gateway", executorType: "hermes_gateway", category: "GATEWAY_META_PROVIDER",
    adapterType: "hermes_gateway", provider: null, enabled: true, operationalStatus: "unverified",
    supportsModels: false, isLocal: false, costClass: "free", speedClass: "fast",
    maxContextTokens: null, healthStatus: "unknown", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-openclaw-gateway", executorType: "openclaw_gateway", category: "GATEWAY_META_PROVIDER",
    adapterType: "openclaw_gateway", provider: null, enabled: true, operationalStatus: "unverified",
    supportsModels: false, isLocal: false, costClass: "free", speedClass: "fast",
    maxContextTokens: null, healthStatus: "unknown", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-paperclip-runner", executorType: "paperclip_runner", category: "TOOL_EXECUTION_ONLY",
    adapterType: "paperclip_runner", provider: "openai", enabled: false, operationalStatus: "confirmed_broken",
    supportsModels: false, isLocal: true, costClass: "free", speedClass: "fast",
    maxContextTokens: null, healthStatus: "degraded", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-acpx-local", executorType: "acpx_local", category: "TOOL_EXECUTION_ONLY",
    adapterType: "acpx_local", provider: null, enabled: false, operationalStatus: "retired",
    supportsModels: false, isLocal: true, costClass: "free", speedClass: "fast",
    maxContextTokens: null, healthStatus: "degraded", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-process", executorType: "process", category: "TOOL_EXECUTION_ONLY",
    adapterType: "process", provider: null, enabled: true, operationalStatus: "unverified",
    supportsModels: false, isLocal: true, costClass: "free", speedClass: "fast",
    maxContextTokens: null, healthStatus: "unknown", lastVerifiedAt: null,
  }),
  builtinExecutor({
    executorId: "exec-http", executorType: "http", category: "TOOL_EXECUTION_ONLY",
    adapterType: "http", provider: null, enabled: true, operationalStatus: "unverified",
    supportsModels: false, isLocal: false, costClass: "free", speedClass: "fast",
    maxContextTokens: null, healthStatus: "unknown", lastVerifiedAt: null,
  }),
];

// Test-only override seam — production code never calls this. Lets dispatch-
// level tests exercise genuine cross-executor dynamic selection and bounded
// fallback (which today's real, honestly-conservative registry data cannot
// produce on its own, since only one executor is confirmed_working) without
// changing any real routing behavior. Always reset in an afterEach.
let testRegistryOverride: readonly ExecutorRecord[] | null = null;

export function __setExecutorRegistryForTests(records: readonly ExecutorRecord[] | null): void {
  testRegistryOverride = records;
}

export function getExecutorRegistry(): readonly ExecutorRecord[] {
  return testRegistryOverride ?? EXECUTOR_REGISTRY;
}

export function getExecutorByType(executorType: string): ExecutorRecord | null {
  return getExecutorRegistry().find((e) => e.executorType === executorType) ?? null;
}

// Only these categories host work substitutable across executors for general
// task routing. ORCHESTRATION_MULTI_AGENT_RUNTIME, TOOL_EXECUTION_ONLY and
// GATEWAY_META_PROVIDER rows are never dynamic-routing candidates regardless
// of operationalStatus — they are categorically different capabilities, not
// interchangeable alternatives for the same work.
const DYNAMIC_ROUTING_ELIGIBLE_CATEGORIES: ReadonlySet<ExecutorCategory> = new Set([
  "GENERAL_LLM_PROVIDER",
  "CODING_AGENT_RUNTIME",
  "AUTONOMOUS_AGENT_RUNTIME",
  "LOCAL_MODEL_RUNTIME",
]);

export function isDynamicRoutingEligibleCategory(category: ExecutorCategory): boolean {
  return DYNAMIC_ROUTING_ELIGIBLE_CATEGORIES.has(category);
}

const CAPABILITY_FLAG_BY_REQUIREMENT: Readonly<Record<CapabilityRequirement, keyof ExecutorCapabilityFlags | null>> = {
  code_edit: "fileEditing",
  git_awareness: "fileEditing",
  file_access: "fileEditing",
  browser: "browser",
  terminal: "terminal",
  gui: "gui",
  tool_calling: "tools",
  local_execution: "localExecution",
  multi_agent: "multiAgent",
  // No registry flag exists for these yet (confirmed absent by the audit) —
  // any requirement for them fails closed until a real capability signal for
  // them is added, never silently assumed satisfied.
  long_context: null,
  structured_output: null,
  multimodal: null,
};

export function executorSatisfiesCapability(executor: ExecutorRecord, requirement: CapabilityRequirement): boolean {
  if (requirement === "long_context") {
    return executor.maxContextTokens !== null && executor.maxContextTokens >= 200_000;
  }
  const flagKey = CAPABILITY_FLAG_BY_REQUIREMENT[requirement];
  if (!flagKey) return false; // structured_output / multimodal — no known-true executor today
  return executor.capabilities[flagKey] === true;
}

export function executorSatisfiesCapabilities(
  executor: ExecutorRecord,
  requirements: readonly CapabilityRequirement[],
): boolean {
  return requirements.every((req) => executorSatisfiesCapability(executor, req));
}
