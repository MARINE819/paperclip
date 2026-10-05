// Pure incident detectors: no process/filesystem/DB/network access. Given
// parsed snapshots of the THREE existing, unmodified signal sources this
// F-06 system reuses rather than duplicates —
//   1. Supervisor's own `control-plane-lifecycle.jsonl` event stream
//      (paperclip-control-plane-supervisor.mjs: probe/recovery_*/runtime_*)
//   2. registry-monitor's current rule-state snapshot
//      (registry-monitor-state.json: previous_rule_statuses, from
//      registry-validator.ps1's R1-R13 PID/port-ownership checks)
//   3. registry-monitor's own alert stream (registry-monitor-alerts.jsonl)
// — each detector returns zero or more incident candidates for the CURRENT
// scan. The caller (incident-scanner.ts) diffs these against open incidents
// to dedupe/resolve. See docs/investigations/nexora-f06-incident-sre-minimum-system-report.md.

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type RootCauseStatus = "known" | "unknown" | "investigating";

export type IncidentCandidate = {
  fingerprint: string;
  code: string;
  severity: IncidentSeverity;
  source: string;
  affectedComponents: string[];
  observedState: Record<string, unknown>;
  expectedState: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  relatedPid?: string | null;
  relatedRunId?: string | null;
  recoveryAttempted: boolean;
  recoveryResult?: string | null;
  rootCause?: string | null;
  rootCauseStatus: RootCauseStatus;
};

export type LifecycleEvent = {
  at: string;
  event: string;
  [key: string]: unknown;
};

export type RegistryMonitorState = {
  previous_overall_status?: string | null;
  previous_rule_statuses?: Record<string, string>;
} | null;

export type IncidentDetectionInput = {
  instanceId: string;
  /** Recent lifecycle.jsonl entries, oldest first. */
  lifecycleEvents: LifecycleEvent[];
  /** Parsed registry-monitor-state.json, or null if unavailable. */
  registryMonitorState: RegistryMonitorState;
  now: number;
};

const CONTROL_C_EXIT_CODE = 3221225786; // 0xC000013A

function latestByEvent(events: LifecycleEvent[], eventName: string): LifecycleEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event === eventName) return events[i];
  }
  return null;
}

function eventsSince(events: LifecycleEvent[], sinceMs: number, eventName?: string): LifecycleEvent[] {
  return events.filter((e) => {
    if (eventName && e.event !== eventName) return false;
    const t = Date.parse(e.at);
    return Number.isFinite(t) && t >= sinceMs;
  });
}

// ===== A. Duplicate Runtime =====
// Sourced from registry-monitor's current rule state: R2 (duplicate
// supervisor process), R7/R8 (ambiguous port owner on 3100/13100), R11
// (live legacy/rogue launch path). Reuses registry-validator.ps1's
// PID/port-ownership snapshot logic rather than re-implementing it.
export function detectDuplicateRuntime(input: IncidentDetectionInput): IncidentCandidate[] {
  const statuses = input.registryMonitorState?.previous_rule_statuses;
  if (!statuses) return [];
  const candidates: IncidentCandidate[] = [];
  const checks: Array<{ rule: string; status: string; label: string }> = [
    { rule: "R2", status: statuses.R2, label: "duplicate supervisor process" },
    { rule: "R7", status: statuses.R7, label: "ambiguous owner on port 3100" },
    { rule: "R8", status: statuses.R8, label: "ambiguous owner on port 13100" },
    { rule: "R11", status: statuses.R11, label: "live legacy/rogue launch path executing" },
  ];
  for (const check of checks) {
    if (check.status === "FAIL" || check.status === "WARN") {
      candidates.push({
        fingerprint: `runtime_duplicate_detected:${input.instanceId}:${check.rule}`,
        code: "runtime_duplicate_detected",
        severity: "high",
        source: "registry_monitor",
        affectedComponents: ["runtime"],
        observedState: { rule: check.rule, status: check.status },
        expectedState: { rule: check.rule, status: "PASS" },
        evidence: [{ rule: check.rule, label: check.label, status: check.status }],
        recoveryAttempted: false,
        rootCauseStatus: "unknown",
      });
    }
  }
  return candidates;
}

// ===== B. Supervisor Recovery Failure =====
// Sourced directly from Supervisor's own lifecycle events: `recovery_cycle_scheduled`
// is Supervisor's unambiguous "exhausted" signal (recoveryAction() returned
// 'exhausted' after 3 failed attempts); a `MANUAL_ATTENTION_REQUIRED` alert
// (surfaced here via the same lifecycle stream is not required — the caller
// may also pass alert-derived events with the same shape) is the other.
export function detectSupervisorRecoveryFailure(input: IncidentDetectionInput): IncidentCandidate[] {
  const windowMs = 15 * 60 * 1000;
  const exhausted = eventsSince(input.lifecycleEvents, input.now - windowMs, "recovery_cycle_scheduled");
  const manualAttention = eventsSince(input.lifecycleEvents, input.now - windowMs, "MANUAL_ATTENTION_REQUIRED");
  if (exhausted.length === 0 && manualAttention.length === 0) return [];
  const evidence = [...exhausted, ...manualAttention].map((e) => ({ ...e }));
  return [
    {
      fingerprint: `supervisor_recovery_failed:${input.instanceId}`,
      code: "supervisor_recovery_failed",
      severity: "critical",
      source: "supervisor_lifecycle",
      affectedComponents: ["supervisor", "runtime"],
      observedState: { exhaustedEvents: exhausted.length, manualAttentionEvents: manualAttention.length },
      expectedState: { exhaustedEvents: 0, manualAttentionEvents: 0 },
      evidence,
      recoveryAttempted: true,
      recoveryResult: "failed",
      rootCauseStatus: "unknown",
    },
  ];
}

// ===== C. Restart Loop =====
// Sourced directly from Supervisor's own `runtime_start_requested` events:
// >=3 fresh runtime starts within a 15-minute sliding window is not normal
// recovery behavior (normal recovery is one start per outage).
export function detectRestartLoop(input: IncidentDetectionInput): IncidentCandidate[] {
  const windowMs = 15 * 60 * 1000;
  const starts = eventsSince(input.lifecycleEvents, input.now - windowMs, "runtime_start_requested");
  if (starts.length < 3) return [];
  return [
    {
      fingerprint: `runtime_restart_loop:${input.instanceId}`,
      code: "runtime_restart_loop",
      severity: "high",
      source: "supervisor_lifecycle",
      affectedComponents: ["runtime", "supervisor"],
      observedState: { startsInWindow: starts.length, windowMinutes: 15 },
      expectedState: { startsInWindow: "< 3", windowMinutes: 15 },
      evidence: starts.map((e) => ({ at: e.at, pid: e.pid })),
      relatedPid: starts[starts.length - 1]?.pid != null ? String(starts[starts.length - 1].pid) : null,
      recoveryAttempted: true,
      recoveryResult: "unknown",
      rootCauseStatus: "unknown",
    },
  ];
}

// ===== D. Connectivity Mismatch =====
// Sourced directly from Supervisor's latest `probe` event (apiReady/
// databaseReady/appPortOpen/dbPortOpen are already independent dimensions —
// see recovery-policy.mjs) plus registry-monitor's R6/R9 (process-tree chain
// connectivity), each a distinct fingerprint so unrelated mismatches don't
// collapse into one incident.
export function detectConnectivityMismatch(input: IncidentDetectionInput): IncidentCandidate[] {
  const candidates: IncidentCandidate[] = [];
  const probe = latestByEvent(input.lifecycleEvents, "probe");
  if (probe) {
    const appPortOpen = Boolean(probe.appPortOpen);
    const dbPortOpen = Boolean(probe.dbPortOpen);
    const apiReady = Boolean(probe.apiReady);
    const dbReady = Boolean(probe.databaseReady);
    const mismatches: Array<{ key: string; label: string; observed: Record<string, unknown> }> = [];
    if (!appPortOpen && dbPortOpen) {
      mismatches.push({ key: "app_down_db_up", label: "app port closed while DB port open", observed: { appPortOpen, dbPortOpen } });
    }
    if (appPortOpen && !apiReady) {
      mismatches.push({ key: "app_open_api_not_ready", label: "app port open but API not ready", observed: { appPortOpen, apiReady } });
    }
    if (dbPortOpen && !dbReady) {
      mismatches.push({ key: "db_open_not_ready", label: "DB port open but DB not ready", observed: { dbPortOpen, dbReady } });
    }
    for (const m of mismatches) {
      candidates.push({
        fingerprint: `runtime_connectivity_mismatch:${input.instanceId}:${m.key}`,
        code: "runtime_connectivity_mismatch",
        severity: "medium",
        source: "supervisor_lifecycle",
        affectedComponents: ["runtime", "database"],
        observedState: m.observed,
        expectedState: { consistent: true },
        evidence: [{ at: probe.at, ...m.observed }],
        recoveryAttempted: false,
        rootCauseStatus: "unknown",
      });
    }
  }

  const statuses = input.registryMonitorState?.previous_rule_statuses;
  if (statuses) {
    const chainChecks: Array<{ rule: string; label: string }> = [
      { rule: "R6", label: "Task->Supervisor->Runtime->API->DB chain broken" },
      { rule: "R9", label: "DB listener owner outside official tree" },
    ];
    for (const check of chainChecks) {
      const status = statuses[check.rule];
      if (status === "FAIL") {
        candidates.push({
          fingerprint: `runtime_connectivity_mismatch:${input.instanceId}:${check.rule}`,
          code: "runtime_connectivity_mismatch",
          severity: "high",
          source: "registry_monitor",
          affectedComponents: ["runtime", "database"],
          observedState: { rule: check.rule, status },
          expectedState: { rule: check.rule, status: "PASS" },
          evidence: [{ rule: check.rule, label: check.label, status }],
          recoveryAttempted: false,
          rootCauseStatus: "unknown",
        });
      }
    }
  }
  return candidates;
}

// ===== E. PID Tracking Mismatch =====
// Sourced from registry-monitor's current rule state: R3/R4/R5 (lock/runtime
// /runtime-info PID files vs live process identity) and R12 (expected parent
// PID vs actual).
export function detectPidTrackingMismatch(input: IncidentDetectionInput): IncidentCandidate[] {
  const statuses = input.registryMonitorState?.previous_rule_statuses;
  if (!statuses) return [];
  const candidates: IncidentCandidate[] = [];
  const checks: Array<{ rule: string; label: string }> = [
    { rule: "R3", label: "supervisor PID lock file mismatch" },
    { rule: "R4", label: "runtime PID file mismatch" },
    { rule: "R5", label: "runtime-info.json PID mismatch" },
    { rule: "R12", label: "expected parent PID mismatch" },
  ];
  for (const check of checks) {
    const status = statuses[check.rule];
    if (status === "FAIL") {
      candidates.push({
        fingerprint: `runtime_pid_mismatch:${input.instanceId}:${check.rule}`,
        code: "runtime_pid_mismatch",
        severity: "high",
        source: "registry_monitor",
        affectedComponents: ["runtime"],
        observedState: { rule: check.rule, status },
        expectedState: { rule: check.rule, status: "PASS" },
        evidence: [{ rule: check.rule, label: check.label, status }],
        recoveryAttempted: false,
        rootCauseStatus: "unknown",
      });
    }
  }
  return candidates;
}

// ===== F. Windows 0xC000013A Watch =====
// Sourced directly from Supervisor's own `runtime_exit` events. One ongoing
// incident per instance that accumulates occurrences as evidence, so
// recurrence is visible without spawning a new incident per event. Root
// cause intentionally stays UNKNOWN — see nexora-f03 investigation.
export function detectWindowsControlCExit(input: IncidentDetectionInput): IncidentCandidate[] {
  const hits = input.lifecycleEvents.filter(
    (e) => e.event === "runtime_exit" && Number(e.code) === CONTROL_C_EXIT_CODE,
  );
  if (hits.length === 0) return [];
  return [
    {
      fingerprint: `windows_control_c_exit_detected:${input.instanceId}`,
      code: "windows_control_c_exit_detected",
      severity: "medium",
      source: "supervisor_lifecycle",
      affectedComponents: ["runtime", "database"],
      observedState: { occurrences: hits.length },
      expectedState: { occurrences: 0 },
      evidence: hits.map((e) => ({ at: e.at, pid: e.pid, code: e.code, signal: e.signal })),
      relatedPid: hits[hits.length - 1]?.pid != null ? String(hits[hits.length - 1].pid) : null,
      recoveryAttempted: true,
      recoveryResult: "succeeded",
      rootCause: null,
      rootCauseStatus: "unknown",
    },
  ];
}

export const ALL_DETECTORS = [
  detectDuplicateRuntime,
  detectSupervisorRecoveryFailure,
  detectRestartLoop,
  detectConnectivityMismatch,
  detectPidTrackingMismatch,
  detectWindowsControlCExit,
] as const;

export function runAllDetectors(input: IncidentDetectionInput): IncidentCandidate[] {
  return ALL_DETECTORS.flatMap((detector) => detector(input));
}
