import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { resolveDefaultLogsDir } from "../home-paths.js";
import {
  runAllDetectors,
  type IncidentDetectionInput,
  type LifecycleEvent,
  type RegistryMonitorState,
} from "./incident-detection.js";
import { applyIncidentScan, type ApplyScanResult } from "./incident-store.js";

const DEFAULT_LIFECYCLE_TAIL_LINES = 2000;

/**
 * Reads the last `maxLines` well-formed JSON entries from a JSONL file.
 * Read-only; a missing file or malformed lines never throw — malformed
 * lines are skipped (this file is written by a separate, unrelated process
 * and must never be treated as trusted-clean input).
 */
export function readRecentLifecycleEvents(
  lifecycleJsonlPath: string,
  maxLines = DEFAULT_LIFECYCLE_TAIL_LINES,
): LifecycleEvent[] {
  if (!existsSync(lifecycleJsonlPath)) return [];
  const raw = readFileSync(lifecycleJsonlPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const tail = lines.slice(-maxLines);
  const events: LifecycleEvent[] = [];
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.at === "string" && typeof parsed.event === "string") {
        events.push(parsed as LifecycleEvent);
      }
    } catch {
      // Skip malformed lines rather than aborting the whole scan.
    }
  }
  return events;
}

/**
 * Reads registry-monitor-state.json (the current PASS/FAIL/WARN/UNKNOWN
 * snapshot per rule, maintained by registry-monitor.ps1 -> registry-validator.ps1).
 * Read-only; returns null if the file is absent or malformed.
 */
export function readRegistryMonitorState(statePath: string): RegistryMonitorState {
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    const statuses = parsed.previous_rule_statuses;
    if (!statuses || typeof statuses !== "object") return null;
    return {
      previous_overall_status:
        typeof parsed.previous_overall_status === "string" ? parsed.previous_overall_status : null,
      previous_rule_statuses: statuses as Record<string, string>,
    };
  } catch {
    return null;
  }
}

export type IncidentScanPaths = {
  lifecycleJsonlPath: string;
  /**
   * registry-monitor-state.json is optional evidence: it lives outside the
   * managed instance root (registry-monitor.ps1 is a standalone operational
   * script, not part of this app's config surface), so there is no safe
   * default to hardcode here. When unset, the PID/duplicate/connectivity
   * detectors that consume it simply contribute nothing for this scan
   * (readRegistryMonitorState already treats a missing file as absent) —
   * the lifecycle-sourced detectors (B, C, D's probe-based checks, F) are
   * unaffected.
   */
  registryMonitorStatePath: string | null;
};

/** Conventional file locations for this Windows deployment's live runtime. */
export function defaultIncidentScanPaths(): IncidentScanPaths {
  return {
    lifecycleJsonlPath: path.join(resolveDefaultLogsDir(), "control-plane-lifecycle.jsonl"),
    registryMonitorStatePath: process.env.PAPERCLIP_REGISTRY_MONITOR_STATE_PATH?.trim() || null,
  };
}

export type RunIncidentScanOptions = {
  db: Db;
  instanceId: string;
  paths: IncidentScanPaths;
  now?: Date;
  lifecycleTailLines?: number;
};

/**
 * One full scan cycle: read the (unmodified, pre-existing) signal files ->
 * run the pure detectors -> diff against stored incidents (open/update/
 * resolve). Safe to call repeatedly and safe to point at synthetic fixture
 * paths for isolated simulation (see incident-scanner.test.ts).
 */
export async function runIncidentScan(options: RunIncidentScanOptions): Promise<ApplyScanResult> {
  const now = options.now ?? new Date();
  const lifecycleEvents = readRecentLifecycleEvents(
    options.paths.lifecycleJsonlPath,
    options.lifecycleTailLines,
  );
  const registryMonitorState = options.paths.registryMonitorStatePath
    ? readRegistryMonitorState(options.paths.registryMonitorStatePath)
    : null;

  const input: IncidentDetectionInput = {
    instanceId: options.instanceId,
    lifecycleEvents,
    registryMonitorState,
    now: now.getTime(),
  };
  const candidates = runAllDetectors(input);
  return applyIncidentScan(options.db, options.instanceId, candidates, lifecycleEvents, now);
}
