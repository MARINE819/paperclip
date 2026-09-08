import { describe, expect, it } from "vitest";
import {
  JARVIS_DELEGATION_PLAN_SCHEMA_VERSION,
  assertSingleSpecialistPlan,
  validateDelegationPlan,
  type DelegationPlan,
} from "./jarvis-delegation-plan.js";

function validPlan(overrides: Partial<DelegationPlan> = {}): unknown {
  return {
    version: JARVIS_DELEGATION_PLAN_SCHEMA_VERSION,
    parentIssueId: "issue-parent-1",
    objective: "Fix the flaky login test",
    constraints: ["Do not modify production configuration"],
    acceptanceCriteria: ["The flaky test passes 10/10 consecutive runs"],
    evidenceRequirements: ["targeted_test"],
    reviewRequired: false,
    taskClass: "development",
    tasks: [
      {
        title: "Stabilize login test",
        instructions: "Investigate and fix the race condition in the login test.",
        requiredCapabilities: ["typescript"],
        dependencies: [],
        riskHints: [],
      },
    ],
    memoryRefs: [],
    ...overrides,
  };
}

describe("validateDelegationPlan", () => {
  it("accepts a well-formed single-task plan", () => {
    const result = validateDelegationPlan(validPlan());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.plan?.tasks).toHaveLength(1);
  });

  it("rejects a plan missing an objective", () => {
    const result = validateDelegationPlan(validPlan({ objective: "" }));
    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.errors.some((e) => e.includes("objective"))).toBe(true);
  });

  it("rejects a plan with no acceptance criteria", () => {
    const result = validateDelegationPlan(validPlan({ acceptanceCriteria: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("acceptanceCriteria"))).toBe(true);
  });

  it("rejects a plan with no evidence requirements", () => {
    const result = validateDelegationPlan(validPlan({ evidenceRequirements: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("evidenceRequirements"))).toBe(true);
  });

  it("rejects a plan with no tasks", () => {
    const result = validateDelegationPlan(validPlan({ tasks: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("tasks"))).toBe(true);
  });

  it("rejects a plan with more than 5 tasks", () => {
    const sixTasks = Array.from({ length: 6 }, (_, i) => ({
      title: `Task ${i}`,
      instructions: "Do something.",
      requiredCapabilities: [],
      dependencies: [],
      riskHints: [],
    }));
    const result = validateDelegationPlan(validPlan({ tasks: sixTasks as DelegationPlan["tasks"] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("tasks"))).toBe(true);
  });

  it("rejects an unknown schema version", () => {
    const result = validateDelegationPlan(validPlan({ version: 2 as typeof JARVIS_DELEGATION_PLAN_SCHEMA_VERSION }));
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid taskClass", () => {
    const result = validateDelegationPlan(validPlan({ taskClass: "not_a_real_class" as DelegationPlan["taskClass"] }));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object input", () => {
    const result = validateDelegationPlan("just a string");
    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
  });

  it("defaults optional array fields and reviewRequired when omitted", () => {
    const raw = validPlan() as Record<string, unknown>;
    delete raw.constraints;
    delete raw.memoryRefs;
    delete raw.reviewRequired;
    const result = validateDelegationPlan(raw);
    expect(result.ok).toBe(true);
    expect(result.plan?.constraints).toEqual([]);
    expect(result.plan?.memoryRefs).toEqual([]);
    expect(result.plan?.reviewRequired).toBe(false);
  });
});

describe("assertSingleSpecialistPlan", () => {
  it("passes for exactly one task", () => {
    const { plan } = validateDelegationPlan(validPlan());
    expect(assertSingleSpecialistPlan(plan!)).toEqual({ ok: true, error: null });
  });

  it("fails for zero or multiple tasks", () => {
    const { plan } = validateDelegationPlan(
      validPlan({
        tasks: [
          { title: "A", instructions: "do a", requiredCapabilities: [], dependencies: [], riskHints: [] },
          { title: "B", instructions: "do b", requiredCapabilities: [], dependencies: [], riskHints: [] },
        ],
      }),
    );
    const check = assertSingleSpecialistPlan(plan!);
    expect(check.ok).toBe(false);
    expect(check.error).toContain("exactly one task");
  });
});
