// F-05 Tool / Plugin Trust Registry — the "Trust Decision Rule" as a pure,
// fail-closed function. This is a READ/ADVISORY decision surface for the
// registry (browsing, testing, and a foundation future runtime integration
// can call into) — it is NOT a replacement for
// server/src/services/tool-access-policy.ts's `decide()`, which remains the
// authoritative real-time tool-call authorization engine for the existing
// company-scoped tool system. This function never performs I/O, never
// grants its own approval, and never treats an unregistered entry, an
// unreviewed entry, or an unverified signature as safe by default.

import type { ToolTrustStatus } from "@paperclipai/shared";

export type TrustRegistryEntryType = "tool" | "mcp" | "plugin";

export type TrustRegistryEntrySnapshot = {
  id: string;
  type: TrustRegistryEntryType;
  name: string;
  provider: string | null;
  version: string | null;
  /** Integrity pin — a mismatch against a caller's expected hash fails closed. */
  versionHash: string | null;
  source: string;
  sourceUrl: string | null;
  trustStatus: ToolTrustStatus;
  riskLevel: string | null;
  requestedScopes: string[];
  approvedScopes: string[];
  signature: string | null;
  signatureVerified: boolean;
  enabled: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

export type TrustDecisionInput = {
  /** null means the id was not found in the registry at all. */
  entry: TrustRegistryEntrySnapshot | null;
  requestedScopes: string[];
  /**
   * The caller's own expected integrity hash for this exact tool version
   * (e.g. pinned at the moment a workflow was authored). Omit to skip the
   * check entirely — this function never invents an expectation to compare
   * against.
   */
  expectedVersionHash?: string | null;
  /**
   * True only when the caller already holds a genuinely-approved Human
   * Approval Gate record for this exact request (from the existing
   * approvals / tool_action_requests system). This function never sets
   * this itself and never treats its absence as anything but "not yet
   * approved" — it cannot be used to bypass the real approval gate.
   */
  approvalGranted?: boolean;
};

export type TrustDecisionReason =
  | "unregistered_fail_closed"
  | "blocked"
  | "revoked"
  | "disabled"
  | "version_mismatch"
  | "signature_unverified"
  | "scope_exceeded"
  | "unreviewed"
  | "risk_requires_approval"
  | "restricted_allowed"
  | "trusted_allowed";

export type TrustDecisionResult = {
  allowed: boolean;
  requiresApproval: boolean;
  reason: TrustDecisionReason;
  restricted: boolean;
};

const HIGH_RISK_LEVELS = new Set(["high", "critical", "destructive"]);

function deny(reason: TrustDecisionReason): TrustDecisionResult {
  return { allowed: false, requiresApproval: false, reason, restricted: false };
}

function requiresApproval(reason: TrustDecisionReason): TrustDecisionResult {
  return { allowed: false, requiresApproval: true, reason, restricted: false };
}

function scopesWithinApproved(requested: string[], approved: string[]): boolean {
  const approvedSet = new Set(approved);
  return requested.every((scope) => approvedSet.has(scope));
}

/**
 * Evaluates whether a request against one trust-registry entry should be
 * allowed. Every branch that isn't an explicit, positively-justified allow
 * denies — there is no fallthrough "allow by default" path.
 */
export function evaluateToolTrust(input: TrustDecisionInput): TrustDecisionResult {
  const { entry } = input;

  if (!entry) return deny("unregistered_fail_closed");
  if (entry.trustStatus === "blocked") return deny("blocked");
  if (entry.trustStatus === "revoked") return deny("revoked");
  if (!entry.enabled) return deny("disabled");

  if (
    input.expectedVersionHash != null &&
    entry.versionHash != null &&
    input.expectedVersionHash !== entry.versionHash
  ) {
    return deny("version_mismatch");
  }

  // A claimed-but-never-verified signature is a red flag; no signature at
  // all is a separate, non-blocking case (no integrity claim was made).
  if (entry.signature != null && !entry.signatureVerified) {
    return deny("signature_unverified");
  }

  if (!scopesWithinApproved(input.requestedScopes, entry.approvedScopes)) {
    return deny("scope_exceeded");
  }

  if (entry.trustStatus === "unreviewed") return deny("unreviewed");

  const risk = entry.riskLevel?.toLowerCase() ?? null;
  if (risk && HIGH_RISK_LEVELS.has(risk)) {
    // High/critical risk always needs a real, externally-granted approval —
    // this branch can never itself flip allowed:true.
    if (!input.approvalGranted) return requiresApproval("risk_requires_approval");
  }

  if (entry.trustStatus === "restricted") {
    return { allowed: true, requiresApproval: false, reason: "restricted_allowed", restricted: true };
  }

  // trustStatus === "trusted" (the only remaining case after the checks above)
  return { allowed: true, requiresApproval: false, reason: "trusted_allowed", restricted: false };
}
