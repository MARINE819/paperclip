import { describe, expect, it } from "vitest";
import {
  detectConnectivityMismatch,
  detectDuplicateRuntime,
  detectPidTrackingMismatch,
  detectRestartLoop,
  detectSupervisorRecoveryFailure,
  detectWindowsControlCExit,
  runAllDetectors,
  type IncidentDetectionInput,
  type LifecycleEvent,
} from "./incident-detection.js";

const NOW = Date.parse("2026-09-30T10:00:00.000Z");

function baseInput(overrides: Partial<IncidentDetectionInput> = {}): IncidentDetectionInput {
  return {
    instanceId: "default",
    lifecycleEvents: [],
    registryMonitorState: null,
    now: NOW,
    ...overrides,
  };
}

describe("incident-detection (pure)", () => {
  it("[1] healthy state -> zero candidates from every detector", () => {
    const input = baseInput({
      lifecycleEvents: [
        { at: "2026-09-30T09:59:00.000Z", event: "probe", apiReady: true, databaseReady: true, appPortOpen: true, dbPortOpen: true },
      ],
      registryMonitorState: {
        previous_overall_status: "PASS",
        previous_rule_statuses: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`R${i + 1}`, "PASS"])),
      },
    });
    expect(runAllDetectors(input)).toHaveLength(0);
  });

  it("[2] duplicate runtime (R2 FAIL) -> exactly one OPEN candidate", () => {
    const input = baseInput({
      registryMonitorState: { previous_overall_status: "FAIL", previous_rule_statuses: { R2: "FAIL" } },
    });
    const candidates = detectDuplicateRuntime(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].code).toBe("runtime_duplicate_detected");
    expect(candidates[0].fingerprint).toBe("runtime_duplicate_detected:default:R2");
  });

  it("[3] identical repeated state -> same fingerprint each scan (dedupe key stable, no growth in candidate count)", () => {
    const input = baseInput({
      registryMonitorState: { previous_overall_status: "FAIL", previous_rule_statuses: { R2: "FAIL" } },
    });
    const first = detectDuplicateRuntime(input);
    const second = detectDuplicateRuntime(input);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].fingerprint).toBe(second[0].fingerprint);
  });

  it("[4] duplicate resolved (R2 back to PASS) -> zero candidates", () => {
    const input = baseInput({
      registryMonitorState: { previous_overall_status: "PASS", previous_rule_statuses: { R2: "PASS" } },
    });
    expect(detectDuplicateRuntime(input)).toHaveLength(0);
  });

  it("[5] appPortOpen=false / dbPortOpen=true -> connectivity mismatch candidate", () => {
    const input = baseInput({
      lifecycleEvents: [
        { at: "2026-09-30T09:59:00.000Z", event: "probe", apiReady: false, databaseReady: true, appPortOpen: false, dbPortOpen: true },
      ],
    });
    const candidates = detectConnectivityMismatch(input);
    expect(candidates.some((c) => c.fingerprint.endsWith("app_down_db_up"))).toBe(true);
  });

  it("[5b] appPortOpen=true / apiReady=false -> distinct mismatch fingerprint", () => {
    const input = baseInput({
      lifecycleEvents: [
        { at: "2026-09-30T09:59:00.000Z", event: "probe", apiReady: false, databaseReady: true, appPortOpen: true, dbPortOpen: true },
      ],
    });
    const candidates = detectConnectivityMismatch(input);
    expect(candidates.some((c) => c.fingerprint.endsWith("app_open_api_not_ready"))).toBe(true);
  });

  it("[5c] dbPortOpen=true / databaseReady=false -> distinct mismatch fingerprint", () => {
    const input = baseInput({
      lifecycleEvents: [
        { at: "2026-09-30T09:59:00.000Z", event: "probe", apiReady: true, databaseReady: false, appPortOpen: true, dbPortOpen: true },
      ],
    });
    const candidates = detectConnectivityMismatch(input);
    expect(candidates.some((c) => c.fingerprint.endsWith("db_open_not_ready"))).toBe(true);
  });

  it("[7] recovery exhausted (recovery_cycle_scheduled) -> recovery_failed candidate", () => {
    const input = baseInput({
      lifecycleEvents: [
        { at: "2026-09-30T09:58:00.000Z", event: "recovery_attempt", attempt: 1 },
        { at: "2026-09-30T09:59:00.000Z", event: "recovery_cycle_scheduled", retryMinutes: 5 },
      ],
    });
    const candidates = detectSupervisorRecoveryFailure(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].code).toBe("supervisor_recovery_failed");
    expect(candidates[0].recoveryResult).toBe("failed");
  });

  it("recovery_attempt alone (not exhausted) -> no recovery_failed candidate", () => {
    const input = baseInput({
      lifecycleEvents: [{ at: "2026-09-30T09:59:00.000Z", event: "recovery_attempt", attempt: 1 }],
    });
    expect(detectSupervisorRecoveryFailure(input)).toHaveLength(0);
  });

  it("[8] repeated restart (>=3 runtime_start_requested in 15min) -> restart_loop candidate", () => {
    const starts: LifecycleEvent[] = [
      { at: "2026-09-30T09:50:00.000Z", event: "runtime_start_requested", pid: 100 },
      { at: "2026-09-30T09:53:00.000Z", event: "runtime_start_requested", pid: 101 },
      { at: "2026-09-30T09:56:00.000Z", event: "runtime_start_requested", pid: 102 },
    ];
    const input = baseInput({ lifecycleEvents: starts });
    const candidates = detectRestartLoop(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].code).toBe("runtime_restart_loop");
  });

  it("only 2 restarts in window -> no restart_loop candidate", () => {
    const input = baseInput({
      lifecycleEvents: [
        { at: "2026-09-30T09:50:00.000Z", event: "runtime_start_requested", pid: 100 },
        { at: "2026-09-30T09:56:00.000Z", event: "runtime_start_requested", pid: 101 },
      ],
    });
    expect(detectRestartLoop(input)).toHaveLength(0);
  });

  it("[9] PID tracking mismatch (R4 FAIL) -> incident candidate", () => {
    const input = baseInput({
      registryMonitorState: { previous_overall_status: "FAIL", previous_rule_statuses: { R4: "FAIL" } },
    });
    const candidates = detectPidTrackingMismatch(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].code).toBe("runtime_pid_mismatch");
  });

  it("[10] 0xC000013A exit -> incident candidate with rootCauseStatus UNKNOWN (never forced to 'known')", () => {
    const input = baseInput({
      lifecycleEvents: [
        { at: "2026-09-30T09:59:00.000Z", event: "runtime_exit", pid: 21924, code: 3221225786, signal: null },
      ],
    });
    const candidates = detectWindowsControlCExit(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].code).toBe("windows_control_c_exit_detected");
    expect(candidates[0].rootCauseStatus).toBe("unknown");
    expect(candidates[0].rootCause).toBeNull();
  });

  it("a normal (non-0xC000013A) runtime_exit does not trigger the watch", () => {
    const input = baseInput({
      lifecycleEvents: [{ at: "2026-09-30T09:59:00.000Z", event: "runtime_exit", pid: 4056, code: 0, signal: null }],
    });
    expect(detectWindowsControlCExit(input)).toHaveLength(0);
  });

  it("repeated 0xC000013A exits accumulate as evidence on the single fingerprint (recurrence visible, not duplicated)", () => {
    const input = baseInput({
      lifecycleEvents: [
        { at: "2026-09-30T09:00:00.000Z", event: "runtime_exit", pid: 100, code: 3221225786, signal: null },
        { at: "2026-09-30T09:30:00.000Z", event: "runtime_exit", pid: 200, code: 3221225786, signal: null },
      ],
    });
    const candidates = detectWindowsControlCExit(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence).toHaveLength(2);
  });

  it("no detector ever performs or requests a mutation — candidates carry no action/kill/restart fields", () => {
    const input = baseInput({
      registryMonitorState: { previous_overall_status: "FAIL", previous_rule_statuses: { R2: "FAIL", R4: "FAIL" } },
      lifecycleEvents: [
        { at: "2026-09-30T09:59:00.000Z", event: "recovery_cycle_scheduled", retryMinutes: 5 },
        { at: "2026-09-30T09:59:00.000Z", event: "runtime_exit", pid: 1, code: 3221225786, signal: null },
      ],
    });
    const candidates = runAllDetectors(input);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c).not.toHaveProperty("action");
      expect(c).not.toHaveProperty("kill");
      expect(c).not.toHaveProperty("restart");
    }
  });
});
