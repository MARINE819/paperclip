import { describe, expect, it } from "vitest";
import { selectDeterministicSpecialist, type JarvisSelectableAgent } from "./jarvis-agent-selector.js";

const COMPANY = "company-1";
const JARVIS_ID = "agent-jarvis";

function agent(overrides: Partial<JarvisSelectableAgent> & { id: string }): JarvisSelectableAgent {
  return {
    companyId: COMPANY,
    name: overrides.id,
    status: "idle",
    reportsTo: null,
    adapterType: "codex_local",
    capabilities: null,
    hasActiveRun: false,
    priority: null,
    ...overrides,
  };
}

describe("selectDeterministicSpecialist", () => {
  it("selects the only eligible candidate", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [agent({ id: "agent-a", capabilities: "typescript, testing" })],
      task: { requiredCapabilities: ["typescript"] },
    });
    expect(result.blocked).toBe(false);
    expect(result.selectedAgentId).toBe("agent-a");
    expect(result.reasonCodes).toContain("capability_matched");
  });

  it("excludes JARVIS itself from candidacy (segregation of duties)", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [agent({ id: JARVIS_ID }), agent({ id: "agent-a" })],
      task: { requiredCapabilities: [] },
    });
    expect(result.selectedAgentId).toBe("agent-a");
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ agentId: JARVIS_ID, reason: "is_orchestrator" }),
    );
  });

  it("excludes agents from a different company", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [agent({ id: "agent-other-co", companyId: "company-2" }), agent({ id: "agent-a" })],
      task: { requiredCapabilities: [] },
    });
    expect(result.selectedAgentId).toBe("agent-a");
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ agentId: "agent-other-co", reason: "different_company" }),
    );
  });

  it("excludes terminated and pending_approval agents via the shared eligibility check", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [
        agent({ id: "agent-terminated", status: "terminated" }),
        agent({ id: "agent-pending", status: "pending_approval" }),
        agent({ id: "agent-ok" }),
      ],
      task: { requiredCapabilities: [] },
    });
    expect(result.selectedAgentId).toBe("agent-ok");
    expect(result.rejected.map((r) => r.agentId).sort()).toEqual(["agent-pending", "agent-terminated"]);
    expect(result.rejected.every((r) => r.reason === "not_assignable")).toBe(true);
  });

  it("excludes agents missing a required capability", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [
        agent({ id: "agent-no-cap", capabilities: "design" }),
        agent({ id: "agent-has-cap", capabilities: "typescript, design" }),
      ],
      task: { requiredCapabilities: ["typescript"] },
    });
    expect(result.selectedAgentId).toBe("agent-has-cap");
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ agentId: "agent-no-cap", reason: "missing_required_capability" }),
    );
  });

  it("is capability-matching case-insensitively via substring", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [agent({ id: "agent-a", capabilities: "TypeScript, Node.js" })],
      task: { requiredCapabilities: ["typescript"] },
    });
    expect(result.selectedAgentId).toBe("agent-a");
  });

  it("returns blocked with no_eligible_agent and never fabricates an agent id when nothing qualifies", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [agent({ id: "agent-terminated", status: "terminated" })],
      task: { requiredCapabilities: [] },
    });
    expect(result.blocked).toBe(true);
    expect(result.selectedAgentId).toBeNull();
    expect(result.reasonCodes).toEqual(["no_eligible_agent"]);
  });

  it("returns blocked (not a fabricated id) when the candidate list is empty", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [],
      task: { requiredCapabilities: [] },
    });
    expect(result.blocked).toBe(true);
    expect(result.selectedAgentId).toBeNull();
  });

  it("prefers an agent with no active run over a busy agent", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [agent({ id: "agent-busy", hasActiveRun: true }), agent({ id: "agent-idle", hasActiveRun: false })],
      task: { requiredCapabilities: [] },
    });
    expect(result.selectedAgentId).toBe("agent-idle");
  });

  it("prefers a lower configured priority number when availability ties", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [agent({ id: "agent-low-priority", priority: 5 }), agent({ id: "agent-high-priority", priority: 1 })],
      task: { requiredCapabilities: [] },
    });
    expect(result.selectedAgentId).toBe("agent-high-priority");
  });

  it("falls back to stable lexicographic agent ID order as the final tie-break", () => {
    const result = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates: [agent({ id: "agent-zzz" }), agent({ id: "agent-aaa" })],
      task: { requiredCapabilities: [] },
    });
    expect(result.selectedAgentId).toBe("agent-aaa");
  });

  it("is deterministic across repeated calls with the same input (no randomness)", () => {
    const candidates = [
      agent({ id: "agent-b", priority: 2 }),
      agent({ id: "agent-a", priority: 2 }),
      agent({ id: "agent-c", hasActiveRun: true }),
    ];
    const first = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates,
      task: { requiredCapabilities: [] },
    });
    const second = selectDeterministicSpecialist({
      companyId: COMPANY,
      jarvisAgentId: JARVIS_ID,
      candidates,
      task: { requiredCapabilities: [] },
    });
    expect(first.selectedAgentId).toBe(second.selectedAgentId);
    expect(first.selectedAgentId).toBe("agent-a");
  });
});
