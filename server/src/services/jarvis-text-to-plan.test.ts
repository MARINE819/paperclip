import { describe, expect, it } from "vitest";
import { validateDelegationPlan, JARVIS_DELEGATION_PLAN_SCHEMA_VERSION } from "./jarvis-delegation-plan.js";
import { selectDeterministicSpecialist, type JarvisSelectableAgent } from "./jarvis-agent-selector.js";
import { buildMinimalDelegationPlanFromText } from "./jarvis-text-to-plan.js";

describe("buildMinimalDelegationPlanFromText", () => {
  it("builds a valid, single-task plan from an ordinary instruction", () => {
    const result = buildMinimalDelegationPlanFromText("Fix the flaky login test");

    expect(result.ok).toBe(true);
    expect(result.plan).not.toBeNull();
    expect(result.plan!.tasks).toHaveLength(1);
    expect(result.plan!.objective).toBe("Fix the flaky login test");
    expect(result.plan!.tasks[0]!.instructions).toBe("Fix the flaky login test");
    // Never guesses a specialist: requiredCapabilities must always be empty,
    // letting selectDeterministicSpecialist's own ranking decide instead.
    expect(result.plan!.tasks[0]!.requiredCapabilities).toEqual([]);
  });

  it("passes the EXISTING, unmodified validateDelegationPlan once version/parentIssueId are filled in by the real caller", () => {
    const result = buildMinimalDelegationPlanFromText("Investigate the slow database query");
    expect(result.ok).toBe(true);

    const validation = validateDelegationPlan({
      version: JARVIS_DELEGATION_PLAN_SCHEMA_VERSION,
      parentIssueId: "issue-real-parent-1",
      objective: result.plan!.objective,
      constraints: result.plan!.constraints ?? [],
      acceptanceCriteria: result.plan!.acceptanceCriteria,
      evidenceRequirements: result.plan!.evidenceRequirements,
      reviewRequired: result.plan!.reviewRequired ?? false,
      taskClass: result.plan!.taskClass,
      tasks: result.plan!.tasks,
      memoryRefs: result.plan!.memoryRefs ?? [],
    });
    expect(validation.ok).toBe(true);
  });

  it("classifies taskClass deterministically from keywords, defaulting to development when nothing matches", () => {
    expect(buildMinimalDelegationPlanFromText("Investigate why the login flow is slow").plan!.taskClass).toBe("research");
    expect(buildMinimalDelegationPlanFromText("Fix the flaky checkout test").plan!.taskClass).toBe("qa");
    expect(buildMinimalDelegationPlanFromText("Draft a roadmap proposal for Q3").plan!.taskClass).toBe("planning");
    expect(buildMinimalDelegationPlanFromText("Review for any security vulnerability").plan!.taskClass).toBe("security");
    expect(buildMinimalDelegationPlanFromText("Reboot the production server").plan!.taskClass).toBe("operations");
    expect(buildMinimalDelegationPlanFromText("Update the project README").plan!.taskClass).toBe("documentation");
    expect(buildMinimalDelegationPlanFromText("Implement the new checkout button").plan!.taskClass).toBe("development");
  });

  it("never fabricates specific acceptance criteria or evidence requirements -- only generic, honest placeholders", () => {
    const result = buildMinimalDelegationPlanFromText("Add dark mode to the settings page");
    expect(result.plan!.acceptanceCriteria).toEqual(["The requested task is completed as described in the request text."]);
    expect(result.plan!.evidenceRequirements).toEqual(["work_product"]);
  });

  it("detects explicit review intent from requestText keywords, defaulting to false when absent", () => {
    expect(buildMinimalDelegationPlanFromText("Implement authentication and request independent review").plan!.reviewRequired).toBe(true);
    expect(buildMinimalDelegationPlanFromText("결제 모듈 개발 및 코드 리뷰 진행").plan!.reviewRequired).toBe(true);
    expect(buildMinimalDelegationPlanFromText("Fix the login bug").plan!.reviewRequired).toBe(false);
    expect(buildMinimalDelegationPlanFromText("Implement code review feature", { reviewRequired: false }).plan!.reviewRequired).toBe(false);
    expect(buildMinimalDelegationPlanFromText("Fix the login bug", { reviewRequired: true }).plan!.reviewRequired).toBe(true);
  });

  it("fails closed for empty or whitespace-only input, never returning a best-effort plan", () => {
    expect(buildMinimalDelegationPlanFromText("").ok).toBe(false);
    expect(buildMinimalDelegationPlanFromText("").plan).toBeNull();
    expect(buildMinimalDelegationPlanFromText("   ").ok).toBe(false);
    expect(buildMinimalDelegationPlanFromText("\n\t  ").ok).toBe(false);
  });

  it("truncates an overlong instruction's task title but preserves the full text in instructions/objective", () => {
    const longText = "Fix the login bug ".repeat(20).trim();
    const result = buildMinimalDelegationPlanFromText(longText);
    expect(result.ok).toBe(true);
    expect(result.plan!.tasks[0]!.title.length).toBeLessThanOrEqual(200);
    expect(result.plan!.objective).toBe(longText);
    expect(result.plan!.tasks[0]!.instructions).toBe(longText);
  });

  it("does not break selectDeterministicSpecialist's existing contract: an empty requiredCapabilities array excludes no one on capability grounds", () => {
    const result = buildMinimalDelegationPlanFromText("Do something useful");
    const candidates: JarvisSelectableAgent[] = [
      { id: "agent-1", companyId: "company-1", name: "Agent One", adapterType: "codex_local", capabilities: null, status: "active" },
      { id: "agent-2", companyId: "company-1", name: "Agent Two", adapterType: "claude_local", capabilities: "typescript, testing", status: "active" },
    ];

    const selection = selectDeterministicSpecialist({
      companyId: "company-1",
      jarvisAgentId: "jarvis-agent",
      candidates,
      task: { requiredCapabilities: result.plan!.tasks[0]!.requiredCapabilities },
    });

    expect(selection.blocked).toBe(false);
    expect(selection.rejected.some((r) => r.reason === "missing_required_capability")).toBe(false);
    // Stable tie-break: agent-1 sorts first lexicographically among two
    // otherwise-equal candidates -- proves ranking, not capability
    // filtering, decided the outcome.
    expect(selection.selectedAgentId).toBe("agent-1");
  });
});
