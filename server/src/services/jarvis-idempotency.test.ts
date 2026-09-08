import { describe, expect, it } from "vitest";
import {
  JARVIS_INTAKE_ORIGIN_KIND,
  buildJarvisIntakeOrigin,
  computeDelegationPlanFingerprint,
  computeJarvisIntakeFingerprint,
} from "./jarvis-idempotency.js";

const BASE_INPUT = {
  companyId: "company-1",
  actorId: "user-1",
  requestText: "Fix the flaky login test",
  sourceType: "paperclip_ui",
  sourceRef: null,
};

describe("computeJarvisIntakeFingerprint", () => {
  it("is deterministic for identical input", () => {
    expect(computeJarvisIntakeFingerprint(BASE_INPUT)).toBe(computeJarvisIntakeFingerprint(BASE_INPUT));
  });

  it("is stable across key ordering (structural, not string, equality)", () => {
    const reordered = {
      sourceType: BASE_INPUT.sourceType,
      requestText: BASE_INPUT.requestText,
      companyId: BASE_INPUT.companyId,
      actorId: BASE_INPUT.actorId,
      sourceRef: BASE_INPUT.sourceRef,
    };
    expect(computeJarvisIntakeFingerprint(BASE_INPUT)).toBe(computeJarvisIntakeFingerprint(reordered));
  });

  it("normalizes incidental whitespace differences in requestText", () => {
    const padded = { ...BASE_INPUT, requestText: "  Fix   the flaky login test  " };
    expect(computeJarvisIntakeFingerprint(BASE_INPUT)).toBe(computeJarvisIntakeFingerprint(padded));
  });

  it("differs when companyId differs (company-scoped fingerprint)", () => {
    expect(computeJarvisIntakeFingerprint(BASE_INPUT)).not.toBe(
      computeJarvisIntakeFingerprint({ ...BASE_INPUT, companyId: "company-2" }),
    );
  });

  it("differs when requestText differs", () => {
    expect(computeJarvisIntakeFingerprint(BASE_INPUT)).not.toBe(
      computeJarvisIntakeFingerprint({ ...BASE_INPUT, requestText: "Fix a different bug" }),
    );
  });

  it("differs when sourceRef differs", () => {
    expect(computeJarvisIntakeFingerprint(BASE_INPUT)).not.toBe(
      computeJarvisIntakeFingerprint({ ...BASE_INPUT, sourceRef: "conversation-42" }),
    );
  });

  it("produces a 64-character hex sha256 digest", () => {
    expect(computeJarvisIntakeFingerprint(BASE_INPUT)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildJarvisIntakeOrigin", () => {
  it("uses the fixed jarvis_delegation_intake origin kind", () => {
    expect(buildJarvisIntakeOrigin(BASE_INPUT).originKind).toBe(JARVIS_INTAKE_ORIGIN_KIND);
    expect(buildJarvisIntakeOrigin(BASE_INPUT).originKind).toBe("jarvis_delegation_intake");
  });

  it("falls back to the request fingerprint as originId when no idempotency key is supplied", () => {
    const origin = buildJarvisIntakeOrigin(BASE_INPUT);
    expect(origin.originId).toBe(origin.originFingerprint);
  });

  it("uses the caller-supplied idempotency key as originId when present", () => {
    const origin = buildJarvisIntakeOrigin({ ...BASE_INPUT, idempotencyKey: "client-key-123" });
    expect(origin.originId).toBe("client-key-123");
    expect(origin.originFingerprint).not.toBe("client-key-123");
  });

  it("ignores a blank idempotency key and falls back to the fingerprint", () => {
    const origin = buildJarvisIntakeOrigin({ ...BASE_INPUT, idempotencyKey: "   " });
    expect(origin.originId).toBe(origin.originFingerprint);
  });

  it("produces identical origin for two calls with the same logical request (idempotent retry)", () => {
    const first = buildJarvisIntakeOrigin(BASE_INPUT);
    const second = buildJarvisIntakeOrigin({ ...BASE_INPUT });
    expect(first).toEqual(second);
  });
});

describe("computeDelegationPlanFingerprint", () => {
  it("is deterministic and key-order independent", () => {
    const planA = { objective: "x", tasks: [{ title: "t" }] };
    const planB = { tasks: [{ title: "t" }], objective: "x" };
    expect(computeDelegationPlanFingerprint(planA)).toBe(computeDelegationPlanFingerprint(planB));
  });

  it("differs for a materially different plan", () => {
    const planA = { objective: "x", tasks: [{ title: "t" }] };
    const planC = { objective: "y", tasks: [{ title: "t" }] };
    expect(computeDelegationPlanFingerprint(planA)).not.toBe(computeDelegationPlanFingerprint(planC));
  });
});
