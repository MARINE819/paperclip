import { describe, expect, it } from "vitest";
import { evaluateToolTrust, type TrustDecisionInput, type TrustRegistryEntrySnapshot } from "./tool-trust-decision.js";

function entry(overrides: Partial<TrustRegistryEntrySnapshot> = {}): TrustRegistryEntrySnapshot {
  return {
    id: "entry-1",
    type: "tool",
    name: "test-tool",
    provider: "Test Provider",
    version: "1.0.0",
    versionHash: "hash-v1",
    source: "rest_api",
    sourceUrl: null,
    trustStatus: "trusted",
    riskLevel: "low",
    requestedScopes: [],
    approvedScopes: ["read:files"],
    signature: null,
    signatureVerified: false,
    enabled: true,
    reviewedAt: "2026-09-30T00:00:00.000Z",
    reviewedBy: "user-1",
    ...overrides,
  };
}

function input(overrides: Partial<TrustDecisionInput> = {}): TrustDecisionInput {
  return {
    entry: entry(),
    requestedScopes: ["read:files"],
    ...overrides,
  };
}

describe("evaluateToolTrust (pure, fail-closed)", () => {
  it("[unknown tool] a null entry (unregistered) always fails closed", () => {
    const result = evaluateToolTrust(input({ entry: null }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("unregistered_fail_closed");
  });

  it("[trusted tool] trusted + low risk + scopes within approved -> allowed", () => {
    const result = evaluateToolTrust(input({ entry: entry({ trustStatus: "trusted", riskLevel: "low" }) }));
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("trusted_allowed");
    expect(result.restricted).toBe(false);
  });

  it("[restricted tool] restricted + scopes within approved -> allowed, flagged restricted", () => {
    const result = evaluateToolTrust(
      input({ entry: entry({ trustStatus: "restricted", riskLevel: "low" }) }),
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("restricted_allowed");
    expect(result.restricted).toBe(true);
  });

  it("[blocked tool] blocked always denies, regardless of scopes or risk", () => {
    const result = evaluateToolTrust(
      input({ entry: entry({ trustStatus: "blocked", riskLevel: "low" }), requestedScopes: [] }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("blocked");
  });

  it("[revoked tool] revoked always denies", () => {
    const result = evaluateToolTrust(input({ entry: entry({ trustStatus: "revoked" }) }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("revoked");
  });

  it("[unreviewed] the default status is never auto-allowed, even with matching scopes and low risk", () => {
    const result = evaluateToolTrust(
      input({ entry: entry({ trustStatus: "unreviewed", riskLevel: "low" }) }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("unreviewed");
  });

  it("[disabled item] a disabled entry denies even if otherwise trusted", () => {
    const result = evaluateToolTrust(input({ entry: entry({ enabled: false }) }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("disabled");
  });

  it("[scope exceed] a requested scope outside approvedScopes denies, even for a trusted entry", () => {
    const result = evaluateToolTrust(
      input({
        entry: entry({ trustStatus: "trusted", approvedScopes: ["read:files"] }),
        requestedScopes: ["read:files", "write:files"],
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("scope_exceeded");
  });

  it("[scope exceed] requesting a strict subset of approvedScopes is fine", () => {
    const result = evaluateToolTrust(
      input({
        entry: entry({ trustStatus: "trusted", approvedScopes: ["read:files", "write:files"] }),
        requestedScopes: ["read:files"],
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it("[version mismatch] a caller's expected hash differing from the entry's current hash denies (integrity)", () => {
    const result = evaluateToolTrust(
      input({
        entry: entry({ trustStatus: "trusted", versionHash: "hash-v2" }),
        expectedVersionHash: "hash-v1",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("version_mismatch");
  });

  it("[version mismatch] a matching expected hash does not deny", () => {
    const result = evaluateToolTrust(
      input({ entry: entry({ trustStatus: "trusted", versionHash: "hash-v1" }), expectedVersionHash: "hash-v1" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("[integrity/signature mismatch] a present-but-unverified signature denies — absence of signature never does", () => {
    const unverified = evaluateToolTrust(
      input({ entry: entry({ trustStatus: "trusted", signature: "sig-abc", signatureVerified: false }) }),
    );
    expect(unverified.allowed).toBe(false);
    expect(unverified.reason).toBe("signature_unverified");

    const verified = evaluateToolTrust(
      input({ entry: entry({ trustStatus: "trusted", signature: "sig-abc", signatureVerified: true }) }),
    );
    expect(verified.allowed).toBe(true);

    const noSignatureAtAll = evaluateToolTrust(
      input({ entry: entry({ trustStatus: "trusted", signature: null, signatureVerified: false }) }),
    );
    expect(noSignatureAtAll.allowed).toBe(true); // no claim made -> not blocked by itself
  });

  it(
    "[Human Approval Gate bypass impossible] no combination of trustStatus/riskLevel alone can produce " +
      "allowed:true for high/critical risk without an externally-granted approval",
    () => {
      for (const trustStatus of ["trusted", "restricted"] as const) {
        for (const riskLevel of ["high", "critical", "destructive"]) {
          const result = evaluateToolTrust(
            input({ entry: entry({ trustStatus, riskLevel }), requestedScopes: [] }),
          );
          expect(result.allowed, `trustStatus=${trustStatus} riskLevel=${riskLevel}`).toBe(false);
          expect(result.requiresApproval, `trustStatus=${trustStatus} riskLevel=${riskLevel}`).toBe(true);
          expect(result.reason).toBe("risk_requires_approval");
        }
      }
    },
  );

  it(
    "[Human Approval Gate honored] once approvalGranted is true (representing a real, externally-verified " +
      "approval), a trusted high-risk request is allowed — the function never fabricates approval itself, " +
      "only honors a pre-existing one",
    () => {
      const result = evaluateToolTrust(
        input({
          entry: entry({ trustStatus: "trusted", riskLevel: "critical" }),
          approvalGranted: true,
        }),
      );
      expect(result.allowed).toBe(true);
    },
  );

  it("approvalGranted alone cannot bypass more fundamental denials (blocked, scope exceeded, unreviewed)", () => {
    expect(
      evaluateToolTrust(input({ entry: entry({ trustStatus: "blocked" }), approvalGranted: true })).allowed,
    ).toBe(false);
    expect(
      evaluateToolTrust(input({ entry: entry({ trustStatus: "unreviewed" }), approvalGranted: true })).allowed,
    ).toBe(false);
    expect(
      evaluateToolTrust(
        input({
          entry: entry({ trustStatus: "trusted", approvedScopes: [] }),
          requestedScopes: ["read:files"],
          approvalGranted: true,
        }),
      ).allowed,
    ).toBe(false);
  });
});
