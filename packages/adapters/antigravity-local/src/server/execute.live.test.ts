import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

type Outcome = "TIMEOUT" | "AUTH_FAILURE" | "NETWORK_FAILURE" | "SAFETY_REJECTED_OTHER" | "REAL_MODEL_SUCCESS";

function classify(result: Awaited<ReturnType<typeof execute>>): Outcome {
  if (result.timedOut) return "TIMEOUT";
  if (result.errorFamily === "refresh_token_expired") return "AUTH_FAILURE";
  if (result.errorMessage && /ENOTFOUND|ECONNREFUSED|ECONNRESET|network/i.test(result.errorMessage)) {
    return "NETWORK_FAILURE";
  }
  if (result.exitCode === 0 && typeof result.summary === "string" && result.summary.length > 0) {
    return "REAL_MODEL_SUCCESS";
  }
  return "SAFETY_REJECTED_OTHER";
}

describe("antigravity-local LIVE CLI probe (real agy.exe -- never collected by the default vitest.config.ts run)", () => {
  it.skipIf(process.env.RUN_LIVE_AGY_TEST !== "1")(
    "LIVE-01: exactly one execute() call against the real agy.exe binary",
    async () => {
      const runtimeDir = mkdtempSync(join(tmpdir(), "antigravity-live-"));
      let primaryError: unknown = null;

      try {
        const ctx: AdapterExecutionContext = {
          runId: "live-probe-run-id",
          agent: {
            id: "live-probe-agent",
            companyId: "live-probe-company",
            name: "LiveProbeAgent",
            adapterType: "antigravity_local",
            adapterConfig: {
              runtimeDir,
              timeoutSec: 60,
              graceSec: 5,
              promptTemplate: "Reply only with: OK",
            },
          },
          runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
          config: {},
          context: { paperclipWake: null },
          onLog: async () => {},
        };

        const result = await execute(ctx);
        const outcome = classify(result);

        switch (outcome) {
          case "TIMEOUT": {
            console.log("LIVE-01 OUTCOME=TIMEOUT: 60s+5s budget exceeded; no real model success claimed.");
            expect(result.exitCode).not.toBe(0);
            break;
          }
          case "AUTH_FAILURE": {
            console.log("LIVE-01 OUTCOME=AUTH_FAILURE: isolated profileDir has no agy.exe login session; no real model success claimed.");
            expect(result.exitCode).not.toBe(0);
            break;
          }
          case "NETWORK_FAILURE": {
            console.log("LIVE-01 OUTCOME=NETWORK_FAILURE: no real model success claimed.");
            expect(result.exitCode).not.toBe(0);
            break;
          }
          case "SAFETY_REJECTED_OTHER": {
            console.log("LIVE-01 OUTCOME=SAFETY_REJECTED_OTHER:", result.errorMessage, "-- no real model success claimed.");
            expect(result.exitCode).not.toBe(0);
            break;
          }
          case "REAL_MODEL_SUCCESS": {
            console.log(
              "LIVE-01 OUTCOME=REAL_MODEL_SUCCESS: a real agy.exe model-API request completed successfully; provider cost may have been incurred. Response:",
              result.summary,
            );
            expect(result.exitCode).toBe(0);
            expect(result.summary!.length).toBeGreaterThan(0);
            break;
          }
          default: {
            expect.fail("Unclassified execute() result: " + JSON.stringify(result));
          }
        }
      } catch (err) {
        primaryError = err;
      } finally {
        let cleanupError: unknown = null;
        try {
          rmSync(runtimeDir, { recursive: true, force: true });
        } catch (err) {
          cleanupError = err;
        }
        if (primaryError || cleanupError) {
          const parts: string[] = [];
          if (primaryError) {
            parts.push("TEST FAILURE: " + (primaryError as Error).message);
          }
          if (cleanupError) {
            parts.push("TEMP DIR CLEANUP FAILURE: " + runtimeDir + " -- " + (cleanupError as Error).message);
          }
          throw new Error(parts.join(" | "));
        }
      }
    },
    75000,
  );
});
