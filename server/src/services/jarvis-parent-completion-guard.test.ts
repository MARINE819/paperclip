import { describe, expect, it } from "vitest";
import { shouldBlockAgentDelegatedParentCompletion } from "./jarvis-parent-completion-guard.js";

describe("shouldBlockAgentDelegatedParentCompletion", () => {
  it("blocks an agent from completing a parent with an accepted delegation plan", () => {
    expect(shouldBlockAgentDelegatedParentCompletion({
      actorType: "agent",
      requestedStatus: "done",
      acceptedPlanDecompositionCount: 1,
    })).toBe(true);
  });

  it("allows Human Board final completion", () => {
    expect(shouldBlockAgentDelegatedParentCompletion({
      actorType: "board",
      requestedStatus: "done",
      acceptedPlanDecompositionCount: 1,
    })).toBe(false);
  });

  it("does not affect ordinary agent Issue transitions", () => {
    expect(shouldBlockAgentDelegatedParentCompletion({
      actorType: "agent",
      requestedStatus: "done",
      acceptedPlanDecompositionCount: 0,
    })).toBe(false);
    expect(shouldBlockAgentDelegatedParentCompletion({
      actorType: "agent",
      requestedStatus: "in_review",
      acceptedPlanDecompositionCount: 1,
    })).toBe(false);
  });
});
