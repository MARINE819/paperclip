import { describe, expect, it } from "vitest";
import {
  buildJudgeResult,
  computeEvalRunStatus,
  detectFailureRateRegression,
  detectRunRegression,
  type EvalMetricsSnapshot,
} from "./eval-engine.js";
import type { ValidatorResult } from "./eval-validators.js";

function det(passed: boolean): ValidatorResult {
  return { type: "exact_value", deterministic: true, passed, details: "" };
}

describe("computeEvalRunStatus (deterministic-first)", () => {
  it("no validator results at all -> error (malformed/incomplete run, fail closed)", () => {
    expect(computeEvalRunStatus([])).toBe("error");
  });

  it("all deterministic validators passed -> passed", () => {
    expect(computeEvalRunStatus([det(true), det(true)])).toBe("passed");
  });

  it("any deterministic validator failed -> failed", () => {
    expect(computeEvalRunStatus([det(true), det(false)])).toBe("failed");
  });

  it("only an LLM judge result, no deterministic validator -> judged_only, never 'passed'", () => {
    const judge = buildJudgeResult({ passed: true, details: "looks great", score: 0.95 });
    expect(computeEvalRunStatus([judge])).toBe("judged_only");
  });

  it(
    "a favorable judge result never overrides a failed deterministic validator, and never upgrades " +
      "judged_only into passed even when present alongside a passing deterministic result",
    () => {
      const judge = buildJudgeResult({ passed: true, details: "looks great", score: 1 });
      expect(computeEvalRunStatus([det(false), judge])).toBe("failed");
      expect(computeEvalRunStatus([det(true), judge])).toBe("passed"); // deterministic pass is authoritative regardless of judge
    },
  );

  it("an unfavorable judge result alone still cannot produce 'failed' status by itself (stays judged_only)", () => {
    const judge = buildJudgeResult({ passed: false, details: "not great" });
    expect(computeEvalRunStatus([judge])).toBe("judged_only");
  });
});

describe("detectRunRegression (pairwise)", () => {
  const base: EvalMetricsSnapshot = { status: "passed", accuracy: 0.9, latencyMs: 1000, cost: 0.01 };

  it("no findings when nothing changed", () => {
    expect(detectRunRegression(base, { ...base })).toHaveLength(0);
  });

  it("[accuracy] flags a drop beyond threshold, not a drop within it", () => {
    const smallDrop = detectRunRegression(base, { ...base, accuracy: 0.87 }); // 0.03 < default 0.05
    expect(smallDrop.some((f) => f.kind === "accuracy_degradation")).toBe(false);
    const bigDrop = detectRunRegression(base, { ...base, accuracy: 0.8 }); // 0.10 > 0.05
    expect(bigDrop.some((f) => f.kind === "accuracy_degradation")).toBe(true);
  });

  it("[failure-rate] previous passed, current failed -> failure_rate_increase", () => {
    const findings = detectRunRegression(base, { ...base, status: "failed" });
    expect(findings.some((f) => f.kind === "failure_rate_increase")).toBe(true);
  });

  it("[latency] flags an increase beyond the ratio threshold", () => {
    const smallIncrease = detectRunRegression(base, { ...base, latencyMs: 1100 }); // +10% < default 20%
    expect(smallIncrease.some((f) => f.kind === "latency_increase")).toBe(false);
    const bigIncrease = detectRunRegression(base, { ...base, latencyMs: 1500 }); // +50%
    expect(bigIncrease.some((f) => f.kind === "latency_increase")).toBe(true);
  });

  it("[cost] flags an increase beyond the ratio threshold", () => {
    const smallIncrease = detectRunRegression(base, { ...base, cost: 0.011 }); // +10%
    expect(smallIncrease.some((f) => f.kind === "cost_increase")).toBe(false);
    const bigIncrease = detectRunRegression(base, { ...base, cost: 0.02 }); // +100%
    expect(bigIncrease.some((f) => f.kind === "cost_increase")).toBe(true);
  });

  it("null metrics on either side never produce a finding for that dimension (fail closed, not fail open)", () => {
    const findings = detectRunRegression(
      { status: "passed", accuracy: null, latencyMs: null, cost: null },
      { status: "passed", accuracy: null, latencyMs: null, cost: null },
    );
    expect(findings).toHaveLength(0);
  });

  it("a run can be 'passed' and still surface a latency/cost finding — findings are informational, not a status override", () => {
    const findings = detectRunRegression(base, { ...base, status: "passed", latencyMs: 2000 });
    expect(findings.some((f) => f.kind === "latency_increase")).toBe(true);
  });
});

describe("detectFailureRateRegression (aggregate)", () => {
  it("flags an aggregate failure-rate increase beyond threshold", () => {
    const previous: EvalMetricsSnapshot[] = Array.from({ length: 10 }, () => ({ status: "passed", accuracy: null, latencyMs: null, cost: null }));
    const current: EvalMetricsSnapshot[] = [
      ...Array.from({ length: 7 }, (): EvalMetricsSnapshot => ({ status: "passed", accuracy: null, latencyMs: null, cost: null })),
      ...Array.from({ length: 3 }, (): EvalMetricsSnapshot => ({ status: "failed", accuracy: null, latencyMs: null, cost: null })),
    ];
    const finding = detectFailureRateRegression(previous, current, 0.1);
    expect(finding).not.toBeNull();
    expect(finding?.kind).toBe("failure_rate_increase");
  });

  it("no finding when the increase is within threshold, or when either set is empty", () => {
    const allPassed: EvalMetricsSnapshot[] = Array.from({ length: 5 }, (): EvalMetricsSnapshot => ({ status: "passed", accuracy: null, latencyMs: null, cost: null }));
    expect(detectFailureRateRegression(allPassed, allPassed, 0.1)).toBeNull();
    expect(detectFailureRateRegression([], allPassed, 0.1)).toBeNull();
    expect(detectFailureRateRegression(allPassed, [], 0.1)).toBeNull();
  });
});
