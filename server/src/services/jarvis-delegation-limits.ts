/**
 * Bounded delegation policy constants for the JARVIS Delegation Loop MVP
 * (docs/architecture/jarvis-delegation-loop-design.md §13.4):
 *   - maximum decomposition depth: 2 below the JARVIS parent
 *   - maximum children per orchestration decision: 5
 * These are deliberately separate from packages/shared's
 * MAX_ISSUE_REQUEST_DEPTH (1024), which is a generic recursion safety clamp
 * for the whole Issue tree, not a delegation-specific business rule.
 */
export const JARVIS_DELEGATION_MAX_DEPTH_BELOW_PARENT = 2;
export const JARVIS_DELEGATION_MAX_CHILDREN_PER_DECISION = 5;

export type DelegationLimitViolationCode =
  | "invalid_depth"
  | "depth_exceeded"
  | "empty_child_batch"
  | "child_count_exceeded";

export interface DelegationLimitViolation {
  code: DelegationLimitViolationCode;
  message: string;
}

/**
 * depthBelowParent counts Issue levels below the JARVIS-owned parent Issue:
 * the parent itself is 0, a direct child is 1, a grandchild is 2. A value
 * above JARVIS_DELEGATION_MAX_DEPTH_BELOW_PARENT is rejected.
 */
export function evaluateDelegationDepth(input: { depthBelowParent: number }): DelegationLimitViolation | null {
  if (!Number.isFinite(input.depthBelowParent) || input.depthBelowParent < 0) {
    return { code: "invalid_depth", message: `depthBelowParent must be a non-negative finite number; received ${input.depthBelowParent}.` };
  }
  if (input.depthBelowParent > JARVIS_DELEGATION_MAX_DEPTH_BELOW_PARENT) {
    return {
      code: "depth_exceeded",
      message: `Delegation depth ${input.depthBelowParent} exceeds the maximum of ${JARVIS_DELEGATION_MAX_DEPTH_BELOW_PARENT} levels below the JARVIS parent issue.`,
    };
  }
  return null;
}

export function evaluateDelegationChildBatchSize(childCount: number): DelegationLimitViolation | null {
  if (!Number.isFinite(childCount) || childCount <= 0) {
    return { code: "empty_child_batch", message: "An orchestration decision must create at least one child issue." };
  }
  if (childCount > JARVIS_DELEGATION_MAX_CHILDREN_PER_DECISION) {
    return {
      code: "child_count_exceeded",
      message: `Requested ${childCount} children exceeds the maximum of ${JARVIS_DELEGATION_MAX_CHILDREN_PER_DECISION} per orchestration decision.`,
    };
  }
  return null;
}

export function evaluateDelegationLimits(input: {
  depthBelowParent: number;
  childCount: number;
}): DelegationLimitViolation[] {
  const violations: DelegationLimitViolation[] = [];
  const depthViolation = evaluateDelegationDepth({ depthBelowParent: input.depthBelowParent });
  if (depthViolation) violations.push(depthViolation);
  const batchViolation = evaluateDelegationChildBatchSize(input.childCount);
  if (batchViolation) violations.push(batchViolation);
  return violations;
}

export function isWithinDelegationLimits(input: { depthBelowParent: number; childCount: number }): boolean {
  return evaluateDelegationLimits(input).length === 0;
}
