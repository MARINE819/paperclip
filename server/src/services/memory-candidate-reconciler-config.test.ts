import { describe, expect, it } from "vitest";
import {
  MEMORY_CANDIDATE_RECONCILER_DEFAULT_BATCH_SIZE,
  MEMORY_CANDIDATE_RECONCILER_DEFAULT_ENABLED,
  MEMORY_CANDIDATE_RECONCILER_DEFAULT_INTERVAL_MS,
  MEMORY_CANDIDATE_RECONCILER_MAX_BATCH_SIZE,
  MEMORY_CANDIDATE_RECONCILER_MIN_INTERVAL_MS,
  resolveMemoryCandidateReconcilerConfig,
} from "./memory-candidate-reconciler-config.js";

describe("resolveMemoryCandidateReconcilerConfig", () => {
  it("enables reconciliation with safe interval and batch defaults when nothing is set", () => {
    const config = resolveMemoryCandidateReconcilerConfig({});
    expect(config).toEqual({
      enabled: MEMORY_CANDIDATE_RECONCILER_DEFAULT_ENABLED,
      intervalMs: MEMORY_CANDIDATE_RECONCILER_DEFAULT_INTERVAL_MS,
      batchSize: MEMORY_CANDIDATE_RECONCILER_DEFAULT_BATCH_SIZE,
    });
    expect(config.enabled).toBe(true);
  });

  it("accepts exact true/false and fails closed for every other explicit value", () => {
    expect(resolveMemoryCandidateReconcilerConfig({ PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED: "true" }).enabled).toBe(true);
    expect(resolveMemoryCandidateReconcilerConfig({ PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED: "false" }).enabled).toBe(false);
    for (const bad of ["1", "yes", "TRUE", "True", " true", ""]) {
      expect(resolveMemoryCandidateReconcilerConfig({ PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED: bad }).enabled).toBe(false);
    }
  });

  it("clamps a too-small interval up to the minimum", () => {
    const config = resolveMemoryCandidateReconcilerConfig({ PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS: "500" });
    expect(config.intervalMs).toBe(MEMORY_CANDIDATE_RECONCILER_MIN_INTERVAL_MS);
  });

  it("accepts a valid interval above the minimum", () => {
    const config = resolveMemoryCandidateReconcilerConfig({ PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS: "120000" });
    expect(config.intervalMs).toBe(120_000);
  });

  it("falls back to the default interval for malformed values", () => {
    for (const bad of ["not-a-number", "-5", "0", ""]) {
      const config = resolveMemoryCandidateReconcilerConfig({ PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS: bad });
      expect(config.intervalMs).toBe(MEMORY_CANDIDATE_RECONCILER_DEFAULT_INTERVAL_MS);
    }
  });

  it("clamps a too-large batch size down to the maximum", () => {
    const config = resolveMemoryCandidateReconcilerConfig({ PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_BATCH_SIZE: "999999" });
    expect(config.batchSize).toBe(MEMORY_CANDIDATE_RECONCILER_MAX_BATCH_SIZE);
  });

  it("falls back to the default batch size for malformed values", () => {
    for (const bad of ["not-a-number", "-1", "0"]) {
      const config = resolveMemoryCandidateReconcilerConfig({ PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_BATCH_SIZE: bad });
      expect(config.batchSize).toBe(MEMORY_CANDIDATE_RECONCILER_DEFAULT_BATCH_SIZE);
    }
  });

  it("reads all three values independently from an injected env object, never process.env", () => {
    const config = resolveMemoryCandidateReconcilerConfig({
      PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_ENABLED: "true",
      PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_INTERVAL_MS: "30000",
      PAPERCLIP_MEMORY_CANDIDATE_RECONCILER_BATCH_SIZE: "5",
    });
    expect(config).toEqual({ enabled: true, intervalMs: 30_000, batchSize: 5 });
  });
});
