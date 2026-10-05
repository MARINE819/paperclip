import { describe, expect, it } from "vitest";
import {
  ALWAYS_REAPPROVE_ACTIONS,
  taskAuthorizationEnvelopeSchema,
  type TaskAuthorizationEnvelope,
} from "@paperclipai/shared/validators/task-authorization-envelope";
import { isActionWithinEnvelope } from "../services/task-authorization-envelope.js";

function makeEnvelope(overrides: Partial<TaskAuthorizationEnvelope> = {}): TaskAuthorizationEnvelope {
  return {
    version: 1,
    level: "safe_mutation",
    riskCeiling: "LOW",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    issuedByUserId: "board-user",
    ...overrides,
  };
}

describe("taskAuthorizationEnvelopeSchema", () => {
  it("accepts a valid minimal envelope", () => {
    expect(() => taskAuthorizationEnvelopeSchema.parse(makeEnvelope())).not.toThrow();
  });

  it("accepts a fully populated envelope", () => {
    expect(() =>
      taskAuthorizationEnvelopeSchema.parse(
        makeEnvelope({
          allowedPaths: ["ui/src/pages/Dashboard.tsx"],
          allowedApiMethods: ["GET", "POST"],
          allowedServiceActions: ["issues.list"],
          allowedGitActions: ["commit"],
          maxOperations: 10,
          riskCeiling: "HIGH",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an envelope missing required fields", () => {
    expect(() => taskAuthorizationEnvelopeSchema.parse({ version: 1, level: "read_only" })).toThrow();
  });

  it("rejects an unsupported version", () => {
    expect(() => taskAuthorizationEnvelopeSchema.parse(makeEnvelope({ version: 2 as 1 }))).toThrow();
  });

  it("rejects git actions outside the safe allow-list (push/deploy are never valid values here)", () => {
    expect(() =>
      taskAuthorizationEnvelopeSchema.parse({
        ...makeEnvelope(),
        allowedGitActions: ["push"],
      }),
    ).toThrow();
  });

  it("defaults riskCeiling to LOW when omitted", () => {
    const { riskCeiling: _omit, ...withoutCeiling } = makeEnvelope();
    expect(taskAuthorizationEnvelopeSchema.parse(withoutCeiling).riskCeiling).toBe("LOW");
  });
});

describe("isActionWithinEnvelope", () => {
  it("denies when there is no envelope", () => {
    expect(isActionWithinEnvelope(null, { action: "read_file", risk: "LOW" })).toBe(false);
    expect(isActionWithinEnvelope(undefined, { action: "read_file", risk: "LOW" })).toBe(false);
  });

  it("allows a LOW-risk action within a live, unrestricted envelope", () => {
    expect(isActionWithinEnvelope(makeEnvelope(), { action: "read_file", risk: "LOW" })).toBe(true);
  });

  it("denies once the envelope has expired", () => {
    const envelope = makeEnvelope({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(isActionWithinEnvelope(envelope, { action: "read_file", risk: "LOW" })).toBe(false);
  });

  it("denies a HIGH-risk action when riskCeiling is LOW", () => {
    const envelope = makeEnvelope({ riskCeiling: "LOW" });
    expect(isActionWithinEnvelope(envelope, { action: "modify_file", risk: "HIGH" })).toBe(false);
  });

  it("allows a HIGH-risk action when riskCeiling is HIGH", () => {
    const envelope = makeEnvelope({ riskCeiling: "HIGH" });
    expect(isActionWithinEnvelope(envelope, { action: "modify_file", risk: "HIGH" })).toBe(true);
  });

  it("denies when maxOperations has already been reached", () => {
    const envelope = makeEnvelope({ maxOperations: 3 });
    expect(
      isActionWithinEnvelope(envelope, { action: "read_file", risk: "LOW", currentOperationCount: 3 }),
    ).toBe(false);
    expect(
      isActionWithinEnvelope(envelope, { action: "read_file", risk: "LOW", currentOperationCount: 2 }),
    ).toBe(true);
  });

  it("denies a path outside an envelope's allowedPaths", () => {
    const envelope = makeEnvelope({ allowedPaths: ["ui/src/pages/Dashboard.tsx"] });
    expect(
      isActionWithinEnvelope(envelope, { action: "modify_file", risk: "LOW", path: "server/src/app.ts" }),
    ).toBe(false);
    expect(
      isActionWithinEnvelope(envelope, {
        action: "modify_file",
        risk: "LOW",
        path: "ui/src/pages/Dashboard.tsx",
      }),
    ).toBe(true);
  });

  it("denies a path-scoped action when no path is given at all", () => {
    const envelope = makeEnvelope({ allowedPaths: ["ui/src/pages/Dashboard.tsx"] });
    expect(isActionWithinEnvelope(envelope, { action: "modify_file", risk: "LOW" })).toBe(false);
  });

  it("denies a service action outside allowedServiceActions", () => {
    const envelope = makeEnvelope({ allowedServiceActions: ["issues.list"] });
    expect(
      isActionWithinEnvelope(envelope, {
        action: "call_service",
        risk: "LOW",
        serviceAction: "issues.delete",
      }),
    ).toBe(false);
    expect(
      isActionWithinEnvelope(envelope, {
        action: "call_service",
        risk: "LOW",
        serviceAction: "issues.list",
      }),
    ).toBe(true);
  });

  // ── Security regression: no envelope content can ever authorize these. ──
  describe("ALWAYS_REAPPROVE_ACTIONS is never bypassable by any envelope", () => {
    const maximallyPermissiveEnvelope = makeEnvelope({
      level: "system_change",
      riskCeiling: "HIGH",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      allowedPaths: ["*"],
      allowedApiMethods: ["GET", "POST", "PATCH", "DELETE"],
      allowedServiceActions: ["*"],
      allowedGitActions: ["commit", "branch"],
    });

    it.each(ALWAYS_REAPPROVE_ACTIONS)("always denies '%s' regardless of envelope contents", (action) => {
      expect(
        isActionWithinEnvelope(maximallyPermissiveEnvelope, {
          action,
          risk: "HIGH",
          path: "*",
          apiMethod: "DELETE",
          serviceAction: "*",
          gitAction: "commit",
        }),
      ).toBe(false);
    });

    it("still denies with no envelope at all", () => {
      for (const action of ALWAYS_REAPPROVE_ACTIONS) {
        expect(isActionWithinEnvelope(null, { action, risk: "HIGH" })).toBe(false);
      }
    });
  });
});
