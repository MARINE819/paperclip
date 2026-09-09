import { describe, expect, it } from "vitest";
import { shouldBlockAgentSelfActionOnOwnWorkProduct } from "./work-product-self-action-guard.js";

describe("shouldBlockAgentSelfActionOnOwnWorkProduct", () => {
  it("blocks an agent acting from the same Run that created the Work Product", () => {
    expect(shouldBlockAgentSelfActionOnOwnWorkProduct({
      actorType: "agent",
      actorRunId: "run-1",
      workProductCreatedByRunId: "run-1",
    })).toBe(true);
  });

  it("allows an agent acting from a different Run", () => {
    expect(shouldBlockAgentSelfActionOnOwnWorkProduct({
      actorType: "agent",
      actorRunId: "run-2",
      workProductCreatedByRunId: "run-1",
    })).toBe(false);
  });

  it("allows Human Board and other non-agent actors regardless of runId", () => {
    expect(shouldBlockAgentSelfActionOnOwnWorkProduct({
      actorType: "board",
      actorRunId: "run-1",
      workProductCreatedByRunId: "run-1",
    })).toBe(false);
  });

  it("does not block when either runId is missing", () => {
    expect(shouldBlockAgentSelfActionOnOwnWorkProduct({
      actorType: "agent",
      actorRunId: null,
      workProductCreatedByRunId: "run-1",
    })).toBe(false);
    expect(shouldBlockAgentSelfActionOnOwnWorkProduct({
      actorType: "agent",
      actorRunId: "run-1",
      workProductCreatedByRunId: null,
    })).toBe(false);
  });
});
