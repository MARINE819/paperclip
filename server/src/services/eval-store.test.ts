import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  BenchmarkCaseNotFoundError,
  computeRegressionForRun,
  createBenchmarkCase,
  getEvalRun,
  getEvalSummary,
  getPreviousVerifiedRun,
  listEvalRuns,
  recordEvalRun,
} from "./eval-store.js";
import { buildJudgeResult } from "./eval-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping eval-store integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function newTestDb() {
  const testDb = await startEmbeddedPostgresTestDatabase("paperclip-eval-store-");
  cleanups.push(testDb.cleanup);
  return createDb(testDb.connectionString);
}

describeEmbeddedPostgres(
  "F-04 eval-store (isolated test DB — synthetic data only, no real model/provider calls)",
  () => {
    it("[create] a benchmark case can be created and a run recorded against it, with metrics persisted intact", async () => {
      const db = await newTestDb();
      const key = `bench-${randomUUID()}`;
      const benchmark = await createBenchmarkCase(db, {
        key,
        name: "Return exact string",
        taskDefinition: { prompt: "reply with OK" },
        validatorSpec: [{ type: "exact_value", expected: "OK", path: "reply" }],
      });
      expect(benchmark.key).toBe(key);
      expect(benchmark.version).toBe(1);

      const run = await recordEvalRun(db, {
        taskId: benchmark.id,
        modelProvider: "anthropic",
        modelName: "claude-sonnet-5",
        actualResult: { reply: "OK" },
        accuracy: 1,
        latencyMs: 850,
        tokenUsage: { input: 100, output: 20, total: 120 },
        costEstimated: 0.002,
        costActual: 0.0019,
      });
      expect(run.status).toBe("passed");
      expect(run.success).toBe("true");
      expect(run.benchmarkKey).toBe(key);
      expect(run.benchmarkVersion).toBe(1);

      // [metrics 저장] every metric field round-trips exactly through the DB.
      const fetched = await getEvalRun(db, run.id);
      expect(fetched?.latencyMs).toBe(850);
      expect(fetched?.tokenUsage).toEqual({ input: 100, output: 20, total: 120 });
      expect(Number(fetched?.accuracy)).toBe(1);
      expect(Number(fetched?.costEstimated)).toBeCloseTo(0.002, 6);
      expect(Number(fetched?.costActual)).toBeCloseTo(0.0019, 6);
    }, 30_000);

    it("[deterministic validation] recording against a benchmark's validatorSpec computes status server-side, not from caller input", async () => {
      const db = await newTestDb();
      const benchmark = await createBenchmarkCase(db, {
        key: `bench-${randomUUID()}`,
        name: "Must return count=0",
        taskDefinition: {},
        validatorSpec: [{ type: "test_result" }],
      });
      const passing = await recordEvalRun(db, {
        taskId: benchmark.id,
        modelProvider: "openai",
        modelName: "gpt-5",
        actualResult: { testResult: { passed: 5, failed: 0, total: 5 } },
      });
      expect(passing.status).toBe("passed");

      const failing = await recordEvalRun(db, {
        taskId: benchmark.id,
        modelProvider: "openai",
        modelName: "gpt-5",
        actualResult: { testResult: { passed: 3, failed: 2, total: 5 } },
      });
      expect(failing.status).toBe("failed");
      expect(failing.validatorResults).toHaveLength(1);
      expect((failing.validatorResults[0] as { passed: boolean }).passed).toBe(false);
    }, 30_000);

    it(
      "[malformed result fail closed] an actualResult missing the fields the validator needs never throws and " +
        "never silently passes — it fails closed with status=failed",
      async () => {
        const db = await newTestDb();
        const benchmark = await createBenchmarkCase(db, {
          key: `bench-${randomUUID()}`,
          name: "Needs testResult",
          taskDefinition: {},
          validatorSpec: [{ type: "test_result" }],
        });
        const run = await recordEvalRun(db, {
          taskId: benchmark.id,
          modelProvider: "anthropic",
          modelName: "claude-sonnet-5",
          actualResult: {}, // malformed: no testResult at all
        });
        expect(run.status).toBe("failed");
        expect((run.validatorResults[0] as { passed: boolean }).passed).toBe(false);
      },
      30_000,
    );

    it("[create] recording against a non-existent benchmark id fails closed with a typed error, not a generic throw", async () => {
      const db = await newTestDb();
      await expect(
        recordEvalRun(db, {
          taskId: randomUUID(),
          modelProvider: "anthropic",
          modelName: "claude-sonnet-5",
          actualResult: {},
        }),
      ).rejects.toBeInstanceOf(BenchmarkCaseNotFoundError);
    }, 30_000);

    it("[provider/model 구분] the same benchmark run by two providers is independently queryable and comparable", async () => {
      const db = await newTestDb();
      const benchmark = await createBenchmarkCase(db, {
        key: `bench-${randomUUID()}`,
        name: "Cross-provider comparison",
        taskDefinition: {},
        validatorSpec: [{ type: "test_result" }],
      });
      await recordEvalRun(db, {
        taskId: benchmark.id, modelProvider: "anthropic", modelName: "claude-sonnet-5",
        actualResult: { testResult: { passed: 1, failed: 0, total: 1 } },
      });
      await recordEvalRun(db, {
        taskId: benchmark.id, modelProvider: "openai", modelName: "gpt-5",
        actualResult: { testResult: { passed: 0, failed: 1, total: 1 } },
      });
      const anthropicRuns = await listEvalRuns(db, { taskId: benchmark.id, modelProvider: "anthropic" });
      const openaiRuns = await listEvalRuns(db, { taskId: benchmark.id, modelProvider: "openai" });
      expect(anthropicRuns).toHaveLength(1);
      expect(anthropicRuns[0].status).toBe("passed");
      expect(openaiRuns).toHaveLength(1);
      expect(openaiRuns[0].status).toBe("failed");
    }, 30_000);

    it("[benchmark comparison / summary] getEvalSummary aggregates pass rate per (benchmark, version, provider, model)", async () => {
      const db = await newTestDb();
      const key = `bench-${randomUUID()}`;
      const benchmark = await createBenchmarkCase(db, {
        key, name: "Summary target", taskDefinition: {}, validatorSpec: [{ type: "test_result" }],
      });
      for (const failed of [0, 0, 1]) {
        await recordEvalRun(db, {
          taskId: benchmark.id, modelProvider: "anthropic", modelName: "claude-sonnet-5",
          actualResult: { testResult: { passed: failed === 0 ? 1 : 0, failed, total: 1 } },
        });
      }
      const summary = await getEvalSummary(db, key);
      expect(summary).toHaveLength(1);
      expect(summary[0].totalRuns).toBe(3);
      expect(summary[0].passedRuns).toBe(2);
      expect(summary[0].failedRuns).toBe(1);
      expect(summary[0].passRate).toBeCloseTo(2 / 3, 6);
    }, 30_000);

    it("[regression detection] a later run's accuracy drop against the previous PASSED run is flagged", async () => {
      const db = await newTestDb();
      const benchmark = await createBenchmarkCase(db, {
        key: `bench-${randomUUID()}`, name: "Regression target", taskDefinition: {},
        validatorSpec: [{ type: "test_result" }],
      });
      const first = await recordEvalRun(db, {
        taskId: benchmark.id, modelProvider: "anthropic", modelName: "claude-sonnet-5",
        actualResult: { testResult: { passed: 1, failed: 0, total: 1 } }, accuracy: 0.95,
      });
      expect(first.status).toBe("passed");
      await new Promise((resolve) => setTimeout(resolve, 5)); // ensure createdAt orders strictly after
      const second = await recordEvalRun(db, {
        taskId: benchmark.id, modelProvider: "anthropic", modelName: "claude-sonnet-5",
        actualResult: { testResult: { passed: 1, failed: 0, total: 1 } }, accuracy: 0.7,
      });
      expect(second.status).toBe("passed"); // still deterministically passed...
      const report = await computeRegressionForRun(db, second.id);
      expect(report?.previousRunId).toBe(first.id);
      expect(report?.findings.some((f) => f.kind === "accuracy_degradation")).toBe(true); // ...but accuracy regressed
    }, 30_000);

    it("[regression detection] no previous PASSED run of the same (benchmark,version,provider,model) -> previousRunId=null, no findings", async () => {
      const db = await newTestDb();
      const benchmark = await createBenchmarkCase(db, {
        key: `bench-${randomUUID()}`, name: "No baseline", taskDefinition: {},
        validatorSpec: [{ type: "test_result" }],
      });
      const run = await recordEvalRun(db, {
        taskId: benchmark.id, modelProvider: "anthropic", modelName: "claude-sonnet-5",
        actualResult: { testResult: { passed: 1, failed: 0, total: 1 } },
      });
      const report = await computeRegressionForRun(db, run.id);
      expect(report?.previousRunId).toBeNull();
      expect(report?.findings).toHaveLength(0);
      expect(await getPreviousVerifiedRun(db, run)).toBeUndefined();
    }, 30_000);

    it("[failed run][retry case] a failed run followed by a retry links via retryOfRunId and retryCount, and the retry can pass", async () => {
      const db = await newTestDb();
      const benchmark = await createBenchmarkCase(db, {
        key: `bench-${randomUUID()}`, name: "Retry target", taskDefinition: {},
        validatorSpec: [{ type: "test_result" }],
      });
      const failedRun = await recordEvalRun(db, {
        taskId: benchmark.id, modelProvider: "anthropic", modelName: "claude-sonnet-5",
        actualResult: { testResult: { passed: 0, failed: 1, total: 1 } }, failureType: "transient_timeout",
      });
      expect(failedRun.status).toBe("failed");
      expect(failedRun.failureType).toBe("transient_timeout");

      const retryRun = await recordEvalRun(db, {
        taskId: benchmark.id, modelProvider: "anthropic", modelName: "claude-sonnet-5",
        actualResult: { testResult: { passed: 1, failed: 0, total: 1 } },
        retryOfRunId: failedRun.id, retryCount: 1,
      });
      expect(retryRun.status).toBe("passed");
      expect(retryRun.retryOfRunId).toBe(failedRun.id);
      expect(retryRun.retryCount).toBe(1);
    }, 30_000);

    it("a judge-only result (no deterministic validator on the benchmark) records as judged_only, never passed", async () => {
      const db = await newTestDb();
      const benchmark = await createBenchmarkCase(db, {
        key: `bench-${randomUUID()}`, name: "Judge only", taskDefinition: {}, validatorSpec: [],
      });
      const run = await recordEvalRun(db, {
        taskId: benchmark.id, modelProvider: "anthropic", modelName: "claude-sonnet-5",
        actualResult: { text: "a lovely essay" },
        judgeResults: [buildJudgeResult({ passed: true, details: "well written", score: 0.9 })],
      });
      expect(run.status).toBe("judged_only");
      expect(run.success).toBeNull();
    }, 30_000);
  },
);

describe("F-04 Human Approval Gate preservation (static source guard)", () => {
  it("eval-store.ts, eval-engine.ts, eval-validators.ts, and routes/evals.ts contain no process-control APIs " +
    "and no approval-bypassing logic", () => {
    const forbidden = /child_process|require\(["']child_process["']\)|\bexec\(|\bspawn\(|process\.kill|taskkill|Stop-Process/i;
    const files = [
      path.join(import.meta.dirname, "eval-store.ts"),
      path.join(import.meta.dirname, "eval-engine.ts"),
      path.join(import.meta.dirname, "eval-validators.ts"),
      path.join(import.meta.dirname, "..", "routes", "evals.ts"),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(forbidden.test(source), `${file} must not reference process-control APIs`).toBe(false);
      expect(source.includes("assertInstanceAdmin") || !file.endsWith("evals.ts")).toBe(true);
    }
  });
});
