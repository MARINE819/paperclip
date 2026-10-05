// F-04 Agent Eval / Simulation Lab — status computation and regression
// detection. Pure functions only (no DB/network access) — see
// eval-store.ts for the persistence layer and eval-validators.ts for the
// deterministic checks this consumes.

import type { ValidatorResult } from "./eval-validators.js";

export type EvalRunStatus = "queued" | "running" | "passed" | "failed" | "error" | "judged_only";

/**
 * Deterministic-first status computation. An LLM judge result
 * (`deterministic: false`) is NEVER sufficient on its own to produce
 * "passed" — a run with only judge results, no matter how favorable, is
 * "judged_only", a status distinct from "passed" specifically so it can
 * never be mistaken for a verified result. When at least one deterministic
 * validator ran, its outcome is authoritative and judge results are purely
 * informational (do not affect the computed status either way).
 */
export function computeEvalRunStatus(validatorResults: ValidatorResult[]): EvalRunStatus {
  if (validatorResults.length === 0) return "error";
  const deterministic = validatorResults.filter((r) => r.deterministic);
  if (deterministic.length === 0) return "judged_only";
  return deterministic.every((r) => r.passed) ? "passed" : "failed";
}

export type JudgeResult = {
  type: "llm_judge";
  deterministic: false;
  passed: boolean;
  details: string;
  score?: number;
  rationale?: string;
};

/**
 * Constructs an LLM judge result with the correct shape. This does not call
 * any model — invoking an actual judge is out of scope for this phase (see
 * F-04 report); this exists so callers (and tests) can attach a
 * synthetically-produced judge opinion in the same shape a real one would
 * use, without ever letting it influence computeEvalRunStatus's outcome.
 */
export function buildJudgeResult(input: { passed: boolean; details: string; score?: number; rationale?: string }): JudgeResult {
  return { type: "llm_judge", deterministic: false, ...input };
}

export type EvalMetricsSnapshot = {
  status: EvalRunStatus;
  accuracy: number | null;
  latencyMs: number | null;
  cost: number | null;
};

export type RegressionFinding = {
  kind: "accuracy_degradation" | "failure_rate_increase" | "latency_increase" | "cost_increase";
  previous: number | string | null;
  current: number | string | null;
  message: string;
};

export type RegressionThresholds = {
  accuracyDrop: number;
  latencyIncreaseRatio: number;
  costIncreaseRatio: number;
};

export const DEFAULT_REGRESSION_THRESHOLDS: RegressionThresholds = {
  accuracyDrop: 0.05,
  latencyIncreaseRatio: 0.2,
  costIncreaseRatio: 0.2,
};

/**
 * Pairwise regression comparison between one previous (verified) run and
 * one current run of the same benchmark case + version. Returns every
 * threshold the current run crossed — an empty array means no regression
 * detected. "Verified" here means the caller already filtered to a
 * previous run whose status was "passed" (this function does not enforce
 * that — see eval-store.ts's selection of the comparison baseline).
 */
export function detectRunRegression(
  previous: EvalMetricsSnapshot,
  current: EvalMetricsSnapshot,
  thresholds: RegressionThresholds = DEFAULT_REGRESSION_THRESHOLDS,
): RegressionFinding[] {
  const findings: RegressionFinding[] = [];

  if (previous.status === "passed" && current.status === "failed") {
    findings.push({
      kind: "failure_rate_increase",
      previous: previous.status,
      current: current.status,
      message: "previous run passed; current run failed",
    });
  }

  if (previous.accuracy != null && current.accuracy != null) {
    const drop = previous.accuracy - current.accuracy;
    if (drop > thresholds.accuracyDrop) {
      findings.push({
        kind: "accuracy_degradation",
        previous: previous.accuracy,
        current: current.accuracy,
        message: `accuracy dropped by ${drop.toFixed(4)} (threshold ${thresholds.accuracyDrop})`,
      });
    }
  }

  if (previous.latencyMs != null && current.latencyMs != null && previous.latencyMs > 0) {
    const ratio = (current.latencyMs - previous.latencyMs) / previous.latencyMs;
    if (ratio > thresholds.latencyIncreaseRatio) {
      findings.push({
        kind: "latency_increase",
        previous: previous.latencyMs,
        current: current.latencyMs,
        message: `latency increased ${(ratio * 100).toFixed(1)}% (threshold ${thresholds.latencyIncreaseRatio * 100}%)`,
      });
    }
  }

  if (previous.cost != null && current.cost != null && previous.cost > 0) {
    const ratio = (current.cost - previous.cost) / previous.cost;
    if (ratio > thresholds.costIncreaseRatio) {
      findings.push({
        kind: "cost_increase",
        previous: previous.cost,
        current: current.cost,
        message: `cost increased ${(ratio * 100).toFixed(1)}% (threshold ${thresholds.costIncreaseRatio * 100}%)`,
      });
    }
  }

  return findings;
}

/** Aggregate failure-rate regression across two sets of runs for the same benchmark. */
export function detectFailureRateRegression(
  previousRuns: EvalMetricsSnapshot[],
  currentRuns: EvalMetricsSnapshot[],
  increaseThreshold = 0.1,
): RegressionFinding | null {
  if (previousRuns.length === 0 || currentRuns.length === 0) return null;
  const rate = (runs: EvalMetricsSnapshot[]) => runs.filter((r) => r.status === "failed").length / runs.length;
  const previousRate = rate(previousRuns);
  const currentRate = rate(currentRuns);
  const increase = currentRate - previousRate;
  if (increase > increaseThreshold) {
    return {
      kind: "failure_rate_increase",
      previous: previousRate,
      current: currentRate,
      message: `failure rate increased from ${(previousRate * 100).toFixed(1)}% to ${(currentRate * 100).toFixed(1)}% (threshold +${increaseThreshold * 100}pp)`,
    };
  }
  return null;
}
