import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { runIncidentScan, type IncidentScanPaths } from "./incident-scanner.js";
import { listOpenIncidents, listResolvedIncidents } from "./incident-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping incident-scanner integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-incident-scan-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeLifecycle(dir: string, events: Record<string, unknown>[]): string {
  const file = path.join(dir, "control-plane-lifecycle.jsonl");
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  return file;
}

function writeRegistryState(dir: string, ruleStatuses: Record<string, string> | null): string | null {
  if (!ruleStatuses) return null;
  const file = path.join(dir, "registry-monitor-state.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ previous_overall_status: "n/a", previous_rule_statuses: ruleStatuses }),
    "utf8",
  );
  return file;
}

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-incident-scan-");
  cleanups.push(testDb.cleanup);
  return createDb(testDb.connectionString);
}

describeEmbeddedPostgres("F-06 incident scanner (isolated simulation, no production process/DB touched)", () => {
  it(
    "[2][3][4] DETECT -> OPEN (1) -> repeated identical scan does not duplicate -> resolves when condition clears",
    async () => {
      const db = await newTestDb();
      const dir = tempDir();
      const paths: IncidentScanPaths = {
        lifecycleJsonlPath: writeLifecycle(dir, []),
        registryMonitorStatePath: writeRegistryState(dir, { R2: "FAIL" }),
      };

      const scan1 = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:00:00Z") });
      expect(scan1.opened).toHaveLength(1);
      expect(scan1.opened[0].code).toBe("runtime_duplicate_detected");
      let open = await listOpenIncidents(db, "default");
      expect(open).toHaveLength(1);

      // [3] identical repeated state must not create a second row, and must
      // not inflate occurrenceCount either: the evidence content (a static
      // rule-status snapshot with no per-scan timestamp) is byte-identical
      // across scans, so this is one continuous observation, not two
      // distinct ones. (A real regression this exact scenario caught live
      // in production: detector F's evidence, re-derived from the same
      // immutable historical runtime_exit line on every scan, was
      // incorrectly inflating occurrenceCount and duplicating evidence for
      // a single 0xC000013A event — see incident-store.ts's dedupe fix.)
      const scan2 = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:01:00Z") });
      expect(scan2.opened).toHaveLength(0);
      expect(scan2.updated).toHaveLength(1);
      open = await listOpenIncidents(db, "default");
      expect(open).toHaveLength(1);
      expect(open[0].occurrenceCount).toBe(1);
      expect(open[0].evidence).toHaveLength(1);

      // [4] condition clears -> resolved.
      writeRegistryState(dir, { R2: "PASS" });
      const scan3 = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:02:00Z") });
      expect(scan3.resolved).toHaveLength(1);
      expect(scan3.resolved[0].status).toBe("resolved");
      expect(scan3.resolved[0].resolvedAt).not.toBeNull();
      open = await listOpenIncidents(db, "default");
      expect(open).toHaveLength(0);
      const resolved = await listResolvedIncidents(db, "default");
      expect(resolved).toHaveLength(1);

      // A single, unchanging observation with no recovery attempt is
      // exactly the one-off-blip case -> NOT a failure-memory candidate.
      expect(resolved[0].occurrenceCount).toBe(1);
      expect(resolved[0].failureMemoryCandidate).toBe(false);
    },
    30_000,
  );

  it("[12b] a genuine one-off (single occurrence, no recovery attempted) resolution is NOT a failure-memory candidate", async () => {
    const db = await newTestDb();
    const dir = tempDir();
    const paths: IncidentScanPaths = {
      lifecycleJsonlPath: writeLifecycle(dir, []),
      registryMonitorStatePath: writeRegistryState(dir, { R2: "FAIL" }),
    };
    await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:00:00Z") });
    writeRegistryState(dir, { R2: "PASS" });
    const scan2 = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:00:30Z") });
    expect(scan2.resolved).toHaveLength(1);
    expect(scan2.resolved[0].occurrenceCount).toBe(1);
    expect(scan2.resolved[0].failureMemoryCandidate).toBe(false);
  }, 30_000);

  it(
    "[6] recovery_attempt -> recovery_succeeded sequence resolves the incident with recoveryResult=succeeded",
    async () => {
      const db = await newTestDb();
      const dir = tempDir();
      const mismatchEvent = { at: "2026-09-30T10:00:00.000Z", event: "probe", apiReady: false, databaseReady: true, appPortOpen: true, dbPortOpen: true };
      const paths: IncidentScanPaths = {
        lifecycleJsonlPath: writeLifecycle(dir, [mismatchEvent]),
        registryMonitorStatePath: null,
      };
      const scan1 = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:00:30Z") });
      expect(scan1.opened.some((i) => i.code === "runtime_connectivity_mismatch")).toBe(true);

      writeLifecycle(dir, [
        mismatchEvent,
        { at: "2026-09-30T10:01:00.000Z", event: "recovery_attempt", attempt: 1 },
        { at: "2026-09-30T10:01:30.000Z", event: "recovery_succeeded", attempt: 1 },
        { at: "2026-09-30T10:01:31.000Z", event: "probe", apiReady: true, databaseReady: true, appPortOpen: true, dbPortOpen: true },
      ]);
      const scan2 = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:02:00Z") });
      const resolved = scan2.resolved.find((i) => i.code === "runtime_connectivity_mismatch");
      expect(resolved).toBeDefined();
      expect(resolved?.recoveryResult).toBe("succeeded");
    },
    30_000,
  );

  it("[7] recovery exhausted (recovery_cycle_scheduled) opens a supervisor_recovery_failed incident", async () => {
    const db = await newTestDb();
    const dir = tempDir();
    const paths: IncidentScanPaths = {
      lifecycleJsonlPath: writeLifecycle(dir, [
        { at: "2026-09-30T10:00:00.000Z", event: "recovery_attempt", attempt: 1 },
        { at: "2026-09-30T10:05:00.000Z", event: "recovery_cycle_scheduled", retryMinutes: 5 },
      ]),
      registryMonitorStatePath: null,
    };
    const scan = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:05:30Z") });
    const opened = scan.opened.find((i) => i.code === "supervisor_recovery_failed");
    expect(opened).toBeDefined();
    expect(opened?.recoveryResult).toBe("failed");
    expect(opened?.severity).toBe("critical");
  }, 30_000);

  it("[8] >=3 runtime restarts within 15 minutes opens a runtime_restart_loop incident", async () => {
    const db = await newTestDb();
    const dir = tempDir();
    const paths: IncidentScanPaths = {
      lifecycleJsonlPath: writeLifecycle(dir, [
        { at: "2026-09-30T09:50:00.000Z", event: "runtime_start_requested", pid: 100 },
        { at: "2026-09-30T09:53:00.000Z", event: "runtime_start_requested", pid: 101 },
        { at: "2026-09-30T09:56:00.000Z", event: "runtime_start_requested", pid: 102 },
      ]),
      registryMonitorStatePath: null,
    };
    const scan = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:00:00Z") });
    expect(scan.opened.some((i) => i.code === "runtime_restart_loop")).toBe(true);
  }, 30_000);

  it("[9] PID tracking mismatch (R4 FAIL) opens a runtime_pid_mismatch incident", async () => {
    const db = await newTestDb();
    const dir = tempDir();
    const paths: IncidentScanPaths = {
      lifecycleJsonlPath: writeLifecycle(dir, []),
      registryMonitorStatePath: writeRegistryState(dir, { R4: "FAIL" }),
    };
    const scan = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:00:00Z") });
    expect(scan.opened.some((i) => i.code === "runtime_pid_mismatch")).toBe(true);
  }, 30_000);

  it(
    "[10] 0xC000013A watch opens an incident end-to-end with rootCause preserved as UNKNOWN (never guessed)",
    async () => {
      const db = await newTestDb();
      const dir = tempDir();
      const paths: IncidentScanPaths = {
        lifecycleJsonlPath: writeLifecycle(dir, [
          { at: "2026-09-30T10:00:00.000Z", event: "runtime_exit", pid: 21924, code: 3221225786, signal: null },
        ]),
        registryMonitorStatePath: null,
      };
      const scan = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:00:30Z") });
      const opened = scan.opened.find((i) => i.code === "windows_control_c_exit_detected");
      expect(opened).toBeDefined();
      expect(opened?.rootCause).toBeNull();
      expect(opened?.rootCauseStatus).toBe("unknown");
    },
    30_000,
  );

  it(
    "[10b] regression: the SAME historical 0xC000013A event, still visible across repeated scans (a Supervisor " +
      "runtime_exit line does not age out of the tail instantly), must not inflate occurrenceCount or duplicate " +
      "evidence — caught live in production before this fix",
    async () => {
      const db = await newTestDb();
      const dir = tempDir();
      const paths: IncidentScanPaths = {
        lifecycleJsonlPath: writeLifecycle(dir, [
          { at: "2026-09-30T10:00:00.000Z", event: "runtime_exit", pid: 21924, code: 3221225786, signal: null },
        ]),
        registryMonitorStatePath: null,
      };
      await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:00:30Z") });
      await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:01:30Z") });
      const scan3 = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:02:30Z") });
      expect(scan3.opened).toHaveLength(0);
      const open = await listOpenIncidents(db, "default");
      const incident = open.find((i) => i.code === "windows_control_c_exit_detected");
      expect(incident).toBeDefined();
      expect(incident?.occurrenceCount).toBe(1);
      expect(incident?.evidence).toHaveLength(1);

      // A genuinely NEW, distinct exit event must still count.
      writeLifecycle(dir, [
        { at: "2026-09-30T10:00:00.000Z", event: "runtime_exit", pid: 21924, code: 3221225786, signal: null },
        { at: "2026-09-30T10:03:00.000Z", event: "runtime_exit", pid: 8604, code: 3221225786, signal: null },
      ]);
      const scan4 = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:03:30Z") });
      expect(scan4.updated).toHaveLength(1);
      const openAfter = await listOpenIncidents(db, "default");
      const incidentAfter = openAfter.find((i) => i.code === "windows_control_c_exit_detected");
      expect(incidentAfter?.occurrenceCount).toBe(2);
      expect(incidentAfter?.evidence).toHaveLength(2);
    },
    30_000,
  );

  it(
    "[12] a recovery-attempted, evidenced resolution becomes a Failure Memory candidate but is never auto-VERIFIED " +
      "(no such status exists in the model)",
    async () => {
      const db = await newTestDb();
      const dir = tempDir();
      const paths: IncidentScanPaths = {
        lifecycleJsonlPath: writeLifecycle(dir, [
          { at: "2026-09-30T10:00:00.000Z", event: "recovery_attempt", attempt: 1 },
          { at: "2026-09-30T10:05:00.000Z", event: "recovery_cycle_scheduled", retryMinutes: 5 },
        ]),
        registryMonitorStatePath: null,
      };
      await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:05:30Z") });

      // Condition clears on the next scan (empty lifecycle -> no more exhausted signal in window).
      writeLifecycle(dir, []);
      const scan2 = await runIncidentScan({ db, instanceId: "default", paths, now: new Date("2026-09-30T10:25:00Z") });
      const resolved = scan2.resolved.find((i) => i.code === "supervisor_recovery_failed");
      expect(resolved).toBeDefined();
      expect(resolved?.failureMemoryCandidate).toBe(true);
      expect(resolved?.failureMemoryDraft).toBeDefined();
      expect(resolved?.failureMemoryDraft).toHaveProperty("problem");
      expect(resolved?.failureMemoryDraft).toHaveProperty("symptoms");
      expect(resolved?.failureMemoryDraft).toHaveProperty("rootCause");
      expect(resolved?.failureMemoryDraft).toHaveProperty("failedAttempts");
      expect(resolved?.failureMemoryDraft).toHaveProperty("verifiedRecovery");
      expect(resolved?.failureMemoryDraft).toHaveProperty("evidence");
      expect(resolved?.failureMemoryDraft).toHaveProperty("recurrencePrevention");
      // The model has exactly three statuses; "VERIFIED" is not one of them,
      // so an auto-promotion bug would have to invent a new value entirely.
      expect(["open", "recovering", "resolved"]).toContain(resolved?.status);
    },
    30_000,
  );

  it(
    "[11] a full scan touching every detector performs zero process/service mutation: only DB rows change, " +
      "target fixture files are untouched",
    async () => {
      const db = await newTestDb();
      const dir = tempDir();
      const lifecyclePath = writeLifecycle(dir, [
        { at: "2026-09-30T10:00:00.000Z", event: "recovery_cycle_scheduled", retryMinutes: 5 },
        { at: "2026-09-30T09:50:00.000Z", event: "runtime_start_requested", pid: 1 },
        { at: "2026-09-30T09:53:00.000Z", event: "runtime_start_requested", pid: 2 },
        { at: "2026-09-30T09:56:00.000Z", event: "runtime_start_requested", pid: 3 },
        { at: "2026-09-30T10:00:00.000Z", event: "runtime_exit", pid: 3, code: 3221225786, signal: null },
      ]);
      const statePath = writeRegistryState(dir, { R2: "FAIL", R4: "FAIL" });
      const beforeLifecycle = fs.readFileSync(lifecyclePath, "utf8");
      const beforeState = fs.readFileSync(statePath!, "utf8");

      const scan = await runIncidentScan({
        db,
        instanceId: "default",
        paths: { lifecycleJsonlPath: lifecyclePath, registryMonitorStatePath: statePath },
        now: new Date("2026-09-30T10:00:30Z"),
      });
      expect(scan.opened.length).toBeGreaterThanOrEqual(4);

      // The scan is a pure reader of these files — proves no self-remediation
      // (e.g. clearing a recovery-state file) ever occurred as a side effect.
      expect(fs.readFileSync(lifecyclePath, "utf8")).toBe(beforeLifecycle);
      expect(fs.readFileSync(statePath!, "utf8")).toBe(beforeState);
    },
    30_000,
  );
});

describe("F-06 Human Approval Gate preservation (static source guard)", () => {
  it("incident-detection.ts and incident-store.ts contain no process-control APIs", () => {
    const forbidden = /child_process|require\(["']child_process["']\)|\bexec\(|\bspawn\(|process\.kill|taskkill|Stop-Process/i;
    for (const file of ["incident-detection.ts", "incident-store.ts", "incident-scanner.ts"]) {
      const source = fs.readFileSync(path.join(import.meta.dirname, file), "utf8");
      expect(forbidden.test(source), `${file} must not reference process-control APIs`).toBe(false);
    }
  });
});
