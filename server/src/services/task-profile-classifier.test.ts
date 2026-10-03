import { describe, expect, it } from "vitest";
import { classifyTaskProfile } from "./task-profile-classifier.js";

describe("classifyTaskProfile — deterministic heuristic classifier", () => {
  it("classifies a bug-fix description as coding with code_edit/git_awareness/file_access requirements", () => {
    const profile = classifyTaskProfile({ title: "Fix bug in the login endpoint", description: "There is a bug in the function that validates tokens." });
    expect(profile.taskType).toBe("coding");
    expect(profile.capabilitiesRequired).toEqual(expect.arrayContaining(["code_edit", "git_awareness", "file_access"]));
    expect(profile.classifierSource).toBe("heuristic_v1");
  });

  it("classifies a browser-automation task and requires browser + tool_calling", () => {
    const profile = classifyTaskProfile({ title: "Navigate to the page and take a screenshot", description: "Use the browser to click through the checkout flow." });
    expect(profile.taskType).toBe("browser_automation");
    expect(profile.capabilitiesRequired).toEqual(expect.arrayContaining(["browser", "tool_calling"]));
  });

  it("classifies a simple triage task as cheapest/fast with low difficulty", () => {
    const profile = classifyTaskProfile({ title: "Classify this incoming ticket", description: "Tag this as a billing issue." });
    expect(profile.taskType).toBe("simple_classification");
    expect(profile.costPreference).toBe("cheapest");
    expect(profile.latencyPreference).toBe("fast");
  });

  it("raises difficulty for architecture/security-flavored long descriptions", () => {
    const longDescription = "architecture ".repeat(100) + "security concurrency race condition root cause";
    const profile = classifyTaskProfile({ title: "Redesign the authorization architecture", description: longDescription });
    expect(profile.difficultyTier).toBe("T4");
    expect(profile.costPreference).toBe("quality_first");
    expect(profile.latencyPreference).toBe("patient");
  });

  it("keeps difficulty low for a short, trivial-keyword task", () => {
    const profile = classifyTaskProfile({ title: "Fix typo in README", description: "simple fix: rename a label." });
    expect(profile.difficultyTier).toBe("T1");
  });

  it("defaults privacy to cloud_allowed unless explicitly overridden or local_private_processing", () => {
    const defaultProfile = classifyTaskProfile({ title: "Research competitor pricing" });
    expect(defaultProfile.privacyRequirement).toBe("cloud_allowed");

    const explicitProfile = classifyTaskProfile({ title: "Research competitor pricing", explicitPrivacyRequirement: "local_only" });
    expect(explicitProfile.privacyRequirement).toBe("local_only");

    const localTaskProfile = classifyTaskProfile({ title: "Process this on-device, do not send to cloud" });
    expect(localTaskProfile.privacyRequirement).toBe("local_only");
    expect(localTaskProfile.capabilitiesRequired).toContain("local_execution");
  });

  it("adds long_context requirement for large expected context without duplicating it", () => {
    const profile = classifyTaskProfile({ title: "Analyze this", description: "x".repeat(3000) });
    expect(profile.expectedContext).toBe("large");
    const longContextCount = profile.capabilitiesRequired.filter((c) => c === "long_context").length;
    expect(longContextCount).toBe(1);
  });

  it("is a pure function: identical input always yields identical output", () => {
    const input = { title: "Implement the new issue endpoint", description: "Add a POST route." };
    const a = classifyTaskProfile(input);
    const b = classifyTaskProfile(input);
    expect(a).toEqual(b);
  });
});
