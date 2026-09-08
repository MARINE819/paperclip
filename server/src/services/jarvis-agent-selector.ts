import { getAgentWorkEligibility, type AgentEligibilityAgent } from "@paperclipai/shared";

/**
 * Deterministic existing-agent selector for the JARVIS Delegation Loop MVP
 * (docs/architecture/jarvis-delegation-loop-design.md §7). This module never
 * creates, hires, or configures an agent: selectDeterministicSpecialist can
 * only return the id of one of the candidates it was given, or report that
 * no eligible candidate exists ("blocked"). Automatic agent creation is out
 * of scope for this slice and is not implemented anywhere in this module.
 *
 * This is intentionally DB-agnostic: callers fetch the candidate rows (e.g.
 * via the existing agents table) and pass plain data in, matching the same
 * pattern @paperclipai/shared's agent-eligibility helpers already use.
 */

export interface JarvisSelectableAgent extends AgentEligibilityAgent {
  adapterType: string;
  /**
   * Raw free-text capabilities field as persisted on the agent record
   * (packages/db/src/schema/agents.ts stores this as a single text column,
   * not a structured array). Matching below is a tolerant substring check
   * over this text, not a strict parse, since no stricter contract for this
   * field was found elsewhere in the codebase at the time this was written.
   */
  capabilities: string | null;
  /** Optional caller-supplied signal that the agent currently owns a live run. Unknown/omitted is treated as available. */
  hasActiveRun?: boolean;
  /** Optional stable configured priority for deterministic tie-breaking; lower sorts first. Agents without one sort last. */
  priority?: number | null;
}

export interface JarvisDelegationTaskRequirements {
  requiredCapabilities: string[];
}

export type JarvisAgentRejectionReason =
  | "different_company"
  | "is_orchestrator"
  | "not_assignable"
  | "missing_required_capability";

export interface JarvisAgentRejection {
  agentId: string;
  reason: JarvisAgentRejectionReason;
  detail: string;
}

export interface JarvisAgentSelectionResult {
  selectedAgentId: string | null;
  blocked: boolean;
  reasonCodes: string[];
  rejected: JarvisAgentRejection[];
}

function normalizeCapabilityText(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase();
}

function hasCapability(normalizedCapabilitiesText: string, requiredCapability: string): boolean {
  const needle = requiredCapability.trim().toLowerCase();
  if (!needle) return true;
  return normalizedCapabilitiesText.includes(needle);
}

/**
 * Selection pipeline, matching
 * docs/architecture/jarvis-delegation-loop-design.md §7.2:
 *   1. hard filter: company scope
 *   2. hard filter: segregation of duties (JARVIS cannot select itself)
 *   3. hard filter: lifecycle/org-chain eligibility (reuses
 *      @paperclipai/shared's getAgentWorkEligibility, the same check the
 *      existing assignment path already enforces)
 *   4. hard filter: required capability match
 *   5. rank: prefer an agent without a known active run
 *   6. rank: prefer a lower configured priority number
 *   7. tie-break: stable lexicographic agent ID order (never model guesswork)
 *
 * Role/capability-exact-match and skill-catalog-availability ranking tiers
 * from the architecture doc are not implemented in this foundation slice —
 * DelegationTask does not currently carry a role field, and skills-catalog
 * integration is out of scope here. This is a deliberate simplification,
 * not a silent omission; every candidate that survives the hard filters is
 * still ranked deterministically by availability/priority/id.
 */
export function selectDeterministicSpecialist(input: {
  companyId: string;
  jarvisAgentId: string;
  candidates: JarvisSelectableAgent[];
  task: JarvisDelegationTaskRequirements;
}): JarvisAgentSelectionResult {
  const { companyId, jarvisAgentId, candidates, task } = input;
  const rejected: JarvisAgentRejection[] = [];
  const eligible: JarvisSelectableAgent[] = [];

  for (const candidate of candidates) {
    if (candidate.companyId !== companyId) {
      rejected.push({
        agentId: candidate.id,
        reason: "different_company",
        detail: `Agent belongs to company ${candidate.companyId}, not ${companyId}.`,
      });
      continue;
    }
    if (candidate.id === jarvisAgentId) {
      rejected.push({
        agentId: candidate.id,
        reason: "is_orchestrator",
        detail: "JARVIS cannot assign the delegated task to itself; the executor must be independent of the orchestrator.",
      });
      continue;
    }
    const eligibility = getAgentWorkEligibility({ agent: candidate, agents: candidates });
    if (!eligibility.assignable) {
      rejected.push({
        agentId: candidate.id,
        reason: "not_assignable",
        detail: `Agent is not assignable (${eligibility.assignabilityReason}).`,
      });
      continue;
    }
    const normalizedCapabilities = normalizeCapabilityText(candidate.capabilities);
    const missing = task.requiredCapabilities.filter((cap) => !hasCapability(normalizedCapabilities, cap));
    if (missing.length > 0) {
      rejected.push({
        agentId: candidate.id,
        reason: "missing_required_capability",
        detail: `Missing required capabilities: ${missing.join(", ")}.`,
      });
      continue;
    }
    eligible.push(candidate);
  }

  if (eligible.length === 0) {
    return {
      selectedAgentId: null,
      blocked: true,
      reasonCodes: ["no_eligible_agent"],
      rejected,
    };
  }

  const ranked = [...eligible].sort((a, b) => {
    const aBusy = a.hasActiveRun === true ? 1 : 0;
    const bBusy = b.hasActiveRun === true ? 1 : 0;
    if (aBusy !== bBusy) return aBusy - bBusy;

    const aPriority = a.priority ?? Number.POSITIVE_INFINITY;
    const bPriority = b.priority ?? Number.POSITIVE_INFINITY;
    if (aPriority !== bPriority) return aPriority - bPriority;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const selected = ranked[0]!;
  return {
    selectedAgentId: selected.id,
    blocked: false,
    reasonCodes: [
      "company_scoped",
      "excluded_orchestrator",
      "eligibility_checked",
      "capability_matched",
      selected.hasActiveRun === false ? "idle_preferred" : "availability_unknown_or_busy",
      "stable_tie_break",
    ],
    rejected,
  };
}
