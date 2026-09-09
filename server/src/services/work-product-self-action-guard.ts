/**
 * Post-Core / Wave 2 Governance Hardening: an Agent must not delete or
 * self-review/approve a Work Product that its own Run created — the same
 * "Evidence Before Claims" principle the JARVIS Parent Completion Guard
 * (jarvis-parent-completion-guard.ts) already enforces for parent Issue
 * completion. Human/Board and any other Actor (including a different Run of
 * the same Agent) remain unaffected.
 */
export function shouldBlockAgentSelfActionOnOwnWorkProduct(input: {
  actorType: string;
  actorRunId: string | null | undefined;
  workProductCreatedByRunId: string | null | undefined;
}): boolean {
  return (
    input.actorType === "agent" &&
    Boolean(input.actorRunId) &&
    input.actorRunId === input.workProductCreatedByRunId
  );
}
