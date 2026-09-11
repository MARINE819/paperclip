import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseObject, asBoolean, asNumber } from "../adapters/utils.js";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable } from "@paperclipai/db";

// Policy Expectation values defined as an object
export const POLICY_EXPECTATIONS = {
  "heartbeat.enabled": { expected: false },
  "heartbeat.maxConcurrentRuns": { expected: 1 },
  "heartbeat.wakeOnDemand": { expected: true }
};

// System default settings (hardcoded fallback values in heartbeat.ts)
const SYSTEM_DEFAULTS = {
  "heartbeat.enabled": false,
  "heartbeat.maxConcurrentRuns": 20,
  "heartbeat.wakeOnDemand": true
};

const COMPANY_ID = "0a7f03e0-98b9-4e03-bd7b-be0d388025b7";
const INSTANCES_ROOT = String.raw`C:\Users\Nexora\.paperclip\instances\default`;

export function getConstitutionHash(): string {
  const constitutionPath = path.join(INSTANCES_ROOT, "companies", COMPANY_ID, "CONSTITUTION.md");
  if (fs.existsSync(constitutionPath)) {
    const content = fs.readFileSync(constitutionPath, "utf8");
    return createHash("sha256").update(content, "utf8").digest("hex");
  }
  return createHash("sha256").update("", "utf8").digest("hex");
}

export interface EffectiveConfigProperty {
  effective: any;
  expected: any;
  compliant: boolean;
  source: string;
  sourceId: string | null;
}

export interface AgentEffectiveConfigResult {
  agentId: string;
  agentName: string;
  resolverVersion: string;
  resolvedAt: string;
  effectiveConfig: Record<string, EffectiveConfigProperty>;
  metadata: {
    constitutionHash: string;
    schemaFingerprint: string;
    configSnapshotHash: string | null;
  };
}

export function resolveAgentEffectiveConfig(agent: any): AgentEffectiveConfigResult {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);

  const constitutionHash = getConstitutionHash();
  const schemaFingerprint = "pending";

  const properties: Record<string, EffectiveConfigProperty> = {};

  // Resolve heartbeat.enabled
  {
    const key = "heartbeat.enabled";
    let effective = SYSTEM_DEFAULTS[key];
    let source = "system_default";
    
    if (heartbeat.enabled !== undefined && heartbeat.enabled !== null) {
      effective = asBoolean(heartbeat.enabled, false);
      source = "explicit";
    }

    const expected = POLICY_EXPECTATIONS[key].expected;
    const compliant = effective === expected;

    properties[key] = {
      effective,
      expected,
      compliant,
      source,
      sourceId: null
    };
  }

  // Resolve heartbeat.maxConcurrentRuns
  {
    const key = "heartbeat.maxConcurrentRuns";
    let effective = SYSTEM_DEFAULTS[key];
    let source = "system_default";

    if (heartbeat.maxConcurrentRuns !== undefined && heartbeat.maxConcurrentRuns !== null) {
      const parsed = Math.floor(asNumber(heartbeat.maxConcurrentRuns, 20));
      effective = Math.max(1, Math.min(50, Number.isFinite(parsed) ? parsed : 20));
      source = "explicit";
    }

    const expected = POLICY_EXPECTATIONS[key].expected;
    const compliant = effective <= expected;

    properties[key] = {
      effective,
      expected,
      compliant,
      source,
      sourceId: null
    };
  }

  // Resolve heartbeat.wakeOnDemand
  {
    const key = "heartbeat.wakeOnDemand";
    let effective = SYSTEM_DEFAULTS[key];
    let source = "system_default";

    const explicitWake = heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation;
    if (explicitWake !== undefined && explicitWake !== null) {
      effective = asBoolean(explicitWake, true);
      source = "explicit";
    }

    const expected = POLICY_EXPECTATIONS[key].expected;
    const compliant = effective === expected;

    properties[key] = {
      effective,
      expected,
      compliant,
      source,
      sourceId: null
    };
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    resolverVersion: "1.0.0",
    resolvedAt: new Date().toISOString(),
    effectiveConfig: properties,
    metadata: {
      constitutionHash,
      schemaFingerprint,
      configSnapshotHash: null
    }
  };
}

export function calculateConfigSnapshotHash(configs: AgentEffectiveConfigResult[]): string {
  const sorted = [...configs].sort((a, b) => a.agentId.localeCompare(b.agentId));
  const canonical = sorted.map((c) => ({
    agentId: c.agentId,
    effectiveConfig: Object.keys(c.effectiveConfig).sort().reduce((acc, key) => {
      acc[key] = {
        effective: c.effectiveConfig[key].effective,
        source: c.effectiveConfig[key].source
      };
      return acc;
    }, {} as any)
  }));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
