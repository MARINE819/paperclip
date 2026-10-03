// NEXORA Intelligent Execution Router — TaskProfile classifier.
// Deterministic, rule-based (NOT LLM-based): an LLM-based classifier would need
// a model choice of its own to classify which model a task needs, which is
// circular and untestable deterministically. See docs/investigations for the
// full design rationale.

export type TaskType =
  | "coding"
  | "research"
  | "planning"
  | "writing"
  | "data_analysis"
  | "simple_classification"
  | "tool_execution"
  | "browser_automation"
  | "gui_automation"
  | "multi_agent_workflow"
  | "local_private_processing";

export type DifficultyTier = "T1" | "T2" | "T3" | "T4";
export type ExpectedContext = "small" | "medium" | "large";
export type LatencyPreference = "fast" | "normal" | "patient";
export type CostPreference = "cheapest" | "balanced" | "quality_first";
export type PrivacyRequirement = "cloud_allowed" | "local_preferred" | "local_only";
export type RiskLevel = "low" | "medium" | "high";

export type CapabilityRequirement =
  | "code_edit"
  | "git_awareness"
  | "browser"
  | "terminal"
  | "gui"
  | "tool_calling"
  | "long_context"
  | "structured_output"
  | "multimodal"
  | "local_execution"
  | "multi_agent"
  | "file_access";

export interface TaskProfile {
  taskType: TaskType;
  difficultyTier: DifficultyTier;
  expectedContext: ExpectedContext;
  latencyPreference: LatencyPreference;
  costPreference: CostPreference;
  privacyRequirement: PrivacyRequirement;
  capabilitiesRequired: readonly CapabilityRequirement[];
  riskLevel: RiskLevel;
  classifierVersion: number;
  classifierSource: "heuristic_v1";
}

export interface TaskProfileClassifierInput {
  title?: string | null;
  description?: string | null;
  labels?: readonly string[] | null;
  explicitPrivacyRequirement?: PrivacyRequirement | null;
  explicitRiskLevel?: RiskLevel | null;
}

export const TASK_PROFILE_CLASSIFIER_VERSION = 1;

const TASK_TYPE_KEYWORDS: ReadonlyArray<readonly [TaskType, readonly string[]]> = [
  ["browser_automation", ["browser", "click", "navigate to", "web page", "screenshot", "playwright", "selenium"]],
  ["gui_automation", ["gui", "desktop app", "window", "mouse", "screen coordinates"]],
  ["multi_agent_workflow", ["multi-agent", "multi agent", "orchestrate", "coordinate agents", "sub-agent", "delegate to"]],
  ["local_private_processing", ["local only", "on-device", "offline", "do not send to cloud", "private document"]],
  ["data_analysis", ["analyze data", "dataset", "csv", "spreadsheet", "metrics report", "statistics"]],
  ["simple_classification", ["classify", "categorize", "label this", "tag this", "triage"]],
  ["tool_execution", ["run command", "execute script", "invoke tool", "call api"]],
  ["writing", ["write a", "draft", "documentation", "blog post", "readme", "copy edit"]],
  ["planning", ["plan", "roadmap", "design doc", "proposal", "architecture decision"]],
  ["research", ["research", "investigate", "compare options", "survey", "literature", "find out"]],
  ["coding", ["fix", "bug", "implement", "refactor", "function", "endpoint", "test", "migration", "code"]],
];

const HIGH_DIFFICULTY_KEYWORDS = ["architecture", "redesign", "refactor the", "security", "concurrency", "race condition", "migration", "distributed", "root cause"];
const LOW_DIFFICULTY_KEYWORDS = ["typo", "rename", "label", "comment", "formatting", "whitespace", "simple fix"];

const CODE_EDIT_TASK_TYPES: ReadonlySet<TaskType> = new Set(["coding"]);

function normalize(text: string | null | undefined): string {
  return typeof text === "string" ? text.toLowerCase() : "";
}

function classifyTaskType(haystack: string): TaskType {
  for (const [type, keywords] of TASK_TYPE_KEYWORDS) {
    if (keywords.some((kw) => haystack.includes(kw))) return type;
  }
  return "coding";
}

function classifyDifficulty(haystack: string, textLength: number): DifficultyTier {
  const highHits = HIGH_DIFFICULTY_KEYWORDS.filter((kw) => haystack.includes(kw)).length;
  const lowHits = LOW_DIFFICULTY_KEYWORDS.filter((kw) => haystack.includes(kw)).length;
  if (highHits >= 2 || (highHits >= 1 && textLength > 800)) return "T4";
  if (highHits >= 1 || textLength > 800) return "T3";
  if (lowHits >= 1 && textLength < 200) return "T1";
  return "T2";
}

function classifyExpectedContext(textLength: number): ExpectedContext {
  if (textLength > 2000) return "large";
  if (textLength > 400) return "medium";
  return "small";
}

function classifyLatencyPreference(taskType: TaskType, difficulty: DifficultyTier): LatencyPreference {
  if (taskType === "simple_classification" || taskType === "tool_execution") return "fast";
  if (difficulty === "T3" || difficulty === "T4") return "patient";
  return "normal";
}

function classifyCostPreference(taskType: TaskType, difficulty: DifficultyTier): CostPreference {
  if (taskType === "simple_classification" || difficulty === "T1") return "cheapest";
  if (difficulty === "T4") return "quality_first";
  return "balanced";
}

function derivePrivacyRequirement(input: TaskProfileClassifierInput, taskType: TaskType): PrivacyRequirement {
  if (input.explicitPrivacyRequirement) return input.explicitPrivacyRequirement;
  if (taskType === "local_private_processing") return "local_only";
  return "cloud_allowed";
}

function deriveRiskLevel(input: TaskProfileClassifierInput, difficulty: DifficultyTier): RiskLevel {
  if (input.explicitRiskLevel) return input.explicitRiskLevel;
  if (difficulty === "T4") return "high";
  if (difficulty === "T3") return "medium";
  return "low";
}

// One fixed capability set per taskType — the minimum a candidate executor must
// support to be considered for that kind of work. An executor whose matching
// capability flag is not literally `true` (including "unknown") never satisfies
// a requirement listed here — see executor-registry.ts's capability match rule.
// structured_output / multimodal are deliberately never listed here: no
// executor in the registry has evidence for either (see
// executor-registry.ts), so requiring them would make that entire taskType
// permanently unroutable by construction — not a meaningful filter, just a
// dead end. Only list a capability here when at least one real executor can
// plausibly satisfy it.
const CAPABILITIES_BY_TASK_TYPE: Readonly<Record<TaskType, readonly CapabilityRequirement[]>> = {
  coding: ["code_edit", "git_awareness", "file_access"],
  research: ["tool_calling"],
  planning: [],
  writing: [],
  data_analysis: ["tool_calling"],
  simple_classification: [],
  tool_execution: ["tool_calling"],
  browser_automation: ["browser", "tool_calling"],
  gui_automation: ["gui"],
  multi_agent_workflow: ["multi_agent", "tool_calling"],
  local_private_processing: ["local_execution"],
};

export function classifyTaskProfile(input: TaskProfileClassifierInput): TaskProfile {
  const text = `${normalize(input.title)} ${normalize(input.description)} ${(input.labels ?? []).map(normalize).join(" ")}`.trim();
  const taskType = classifyTaskType(text);
  const difficultyTier = classifyDifficulty(text, text.length);
  const expectedContext = classifyExpectedContext(text.length);
  const capabilitiesRequired = [...CAPABILITIES_BY_TASK_TYPE[taskType]];
  if (expectedContext === "large" && !capabilitiesRequired.includes("long_context")) {
    capabilitiesRequired.push("long_context");
  }
  return {
    taskType,
    difficultyTier,
    expectedContext,
    latencyPreference: classifyLatencyPreference(taskType, difficultyTier),
    costPreference: classifyCostPreference(taskType, difficultyTier),
    privacyRequirement: derivePrivacyRequirement(input, taskType),
    capabilitiesRequired,
    riskLevel: deriveRiskLevel(input, difficultyTier),
    classifierVersion: TASK_PROFILE_CLASSIFIER_VERSION,
    classifierSource: "heuristic_v1",
  };
}

export function requiresCodeEdit(taskType: TaskType): boolean {
  return CODE_EDIT_TASK_TYPES.has(taskType);
}
