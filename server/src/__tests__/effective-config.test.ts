import { describe, expect, it } from "vitest";
import { resolveAgentEffectiveConfig, calculateConfigSnapshotHash } from "../services/effective-config.js";

describe("Effective Config Resolver Service", () => {
  it("resolves default config when agent runtimeConfig is empty or missing heartbeat", () => {
    const mockAgent = {
      id: "agent-1",
      name: "Test Agent 1",
      runtimeConfig: {}
    };

    const resolved = resolveAgentEffectiveConfig(mockAgent);

    expect(resolved.agentId).toBe("agent-1");
    expect(resolved.agentName).toBe("Test Agent 1");
    expect(resolved.resolverVersion).toBe("1.0.0");
    expect(resolved.effectiveConfig["heartbeat.enabled"]).toEqual({
      effective: false,
      expected: false,
      compliant: true,
      source: "system_default",
      sourceId: null
    });
    expect(resolved.effectiveConfig["heartbeat.maxConcurrentRuns"]).toEqual({
      effective: 20,
      expected: 1,
      compliant: false,
      source: "system_default",
      sourceId: null
    });
  });

  it("resolves explicitly set configs when overrides are present in runtimeConfig", () => {
    const mockAgent = {
      id: "agent-2",
      name: "Test Agent 2",
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          maxConcurrentRuns: 1,
          wakeOnDemand: false
        }
      }
    };

    const resolved = resolveAgentEffectiveConfig(mockAgent);

    expect(resolved.effectiveConfig["heartbeat.enabled"]).toEqual({
      effective: true,
      expected: false,
      compliant: false,
      source: "explicit",
      sourceId: null
    });
    expect(resolved.effectiveConfig["heartbeat.maxConcurrentRuns"]).toEqual({
      effective: 1,
      expected: 1,
      compliant: true,
      source: "explicit",
      sourceId: null
    });
    expect(resolved.effectiveConfig["heartbeat.wakeOnDemand"]).toEqual({
      effective: false,
      expected: true,
      compliant: false,
      source: "explicit",
      sourceId: null
    });
  });

  it("calculates canonical configSnapshotHash deterministically based on agent config", () => {
    const configA = resolveAgentEffectiveConfig({
      id: "agent-a",
      name: "Agent A",
      runtimeConfig: { heartbeat: { enabled: true } }
    });
    const configB = resolveAgentEffectiveConfig({
      id: "agent-b",
      name: "Agent B",
      runtimeConfig: { heartbeat: { enabled: false } }
    });

    const hash1 = calculateConfigSnapshotHash([configA, configB]);
    const hash2 = calculateConfigSnapshotHash([configB, configA]);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });
});
