export function shouldBlockAgentDelegatedParentCompletion(input: {
  actorType: "agent" | "board";
  requestedStatus?: string;
  acceptedPlanDecompositionCount: number;
}): boolean {
  return input.actorType === "agent"
    && input.requestedStatus === "done"
    && input.acceptedPlanDecompositionCount > 0;
}
