import { describe, expect, it } from "vitest";
import {
  JARVIS_DELEGATION_MAX_CHILDREN_PER_DECISION,
  JARVIS_DELEGATION_MAX_DEPTH_BELOW_PARENT,
  evaluateDelegationChildBatchSize,
  evaluateDelegationDepth,
  evaluateDelegationLimits,
  isWithinDelegationLimits,
} from "./jarvis-delegation-limits.js";

describe("evaluateDelegationDepth", () => {
  it("allows the parent itself (depth 0)", () => {
    expect(evaluateDelegationDepth({ depthBelowParent: 0 })).toBeNull();
  });

  it("allows a direct child (depth 1)", () => {
    expect(evaluateDelegationDepth({ depthBelowParent: 1 })).toBeNull();
  });

  it("allows the maximum configured depth", () => {
    expect(evaluateDelegationDepth({ depthBelowParent: JARVIS_DELEGATION_MAX_DEPTH_BELOW_PARENT })).toBeNull();
  });

  it("rejects one level past the maximum depth", () => {
    const violation = evaluateDelegationDepth({ depthBelowParent: JARVIS_DELEGATION_MAX_DEPTH_BELOW_PARENT + 1 });
    expect(violation?.code).toBe("depth_exceeded");
  });

  it("rejects a negative depth", () => {
    const violation = evaluateDelegationDepth({ depthBelowParent: -1 });
    expect(violation?.code).toBe("invalid_depth");
  });

  it("rejects a non-finite depth", () => {
    const violation = evaluateDelegationDepth({ depthBelowParent: Number.NaN });
    expect(violation?.code).toBe("invalid_depth");
  });
});

describe("evaluateDelegationChildBatchSize", () => {
  it("allows one child", () => {
    expect(evaluateDelegationChildBatchSize(1)).toBeNull();
  });

  it("allows exactly the configured maximum", () => {
    expect(evaluateDelegationChildBatchSize(JARVIS_DELEGATION_MAX_CHILDREN_PER_DECISION)).toBeNull();
  });

  it("rejects one more than the configured maximum", () => {
    const violation = evaluateDelegationChildBatchSize(JARVIS_DELEGATION_MAX_CHILDREN_PER_DECISION + 1);
    expect(violation?.code).toBe("child_count_exceeded");
  });

  it("rejects zero children", () => {
    const violation = evaluateDelegationChildBatchSize(0);
    expect(violation?.code).toBe("empty_child_batch");
  });

  it("rejects a negative child count", () => {
    const violation = evaluateDelegationChildBatchSize(-3);
    expect(violation?.code).toBe("empty_child_batch");
  });
});

describe("evaluateDelegationLimits / isWithinDelegationLimits", () => {
  it("returns no violations for a compliant single-child decision at depth 1", () => {
    const violations = evaluateDelegationLimits({ depthBelowParent: 1, childCount: 1 });
    expect(violations).toEqual([]);
    expect(isWithinDelegationLimits({ depthBelowParent: 1, childCount: 1 })).toBe(true);
  });

  it("reports both violations when depth and batch size are both exceeded", () => {
    const violations = evaluateDelegationLimits({
      depthBelowParent: JARVIS_DELEGATION_MAX_DEPTH_BELOW_PARENT + 5,
      childCount: JARVIS_DELEGATION_MAX_CHILDREN_PER_DECISION + 5,
    });
    expect(violations.map((v) => v.code).sort()).toEqual(["child_count_exceeded", "depth_exceeded"]);
    expect(
      isWithinDelegationLimits({
        depthBelowParent: JARVIS_DELEGATION_MAX_DEPTH_BELOW_PARENT + 5,
        childCount: JARVIS_DELEGATION_MAX_CHILDREN_PER_DECISION + 5,
      }),
    ).toBe(false);
  });
});
