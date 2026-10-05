import { createHash } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  taskAuthorizationEnvelopes,
  taskAuthorizationEnvelopeConsumptions,
  toolCatalogEntries,
  toolConnections,
} from "@paperclipai/db";
import {
  ALWAYS_REAPPROVE_ACTIONS,
  type TaskAuthorizationEnvelope,
} from "@paperclipai/shared/validators/task-authorization-envelope";

/**
 * NEXORA Master 2 — Task Authorization Envelope (Phase 1: pure evaluation
 * only). Nothing in this repository calls this function yet — it is not
 * wired into heartbeat.ts's Risk Guard, tool-gateway, or any route. It has
 * no side effects and makes no DB/network call, so importing or calling it
 * cannot change any existing runtime behavior.
 */
export interface EnvelopeActionContext {
  action: string;
  risk: "LOW" | "HIGH";
  path?: string;
  apiMethod?: "GET" | "POST" | "PATCH" | "DELETE";
  serviceAction?: string;
  gitAction?: "commit" | "branch";
  /** Operations already consumed under this envelope, for maxOperations enforcement. */
  currentOperationCount?: number;
  now?: Date;
}

/**
 * Whether `context` is authorized by `envelope` without a fresh Human
 * Approval Gate decision. `ALWAYS_REAPPROVE_ACTIONS` is checked first and
 * unconditionally — no envelope field can ever widen it, by construction:
 * this function never reads any part of `envelope` before that check.
 */
export function isActionWithinEnvelope(
  envelope: TaskAuthorizationEnvelope | null | undefined,
  context: EnvelopeActionContext,
): boolean {
  if ((ALWAYS_REAPPROVE_ACTIONS as readonly string[]).includes(context.action)) {
    return false;
  }

  if (!envelope) return false;

  const now = context.now ?? new Date();
  if (new Date(envelope.expiresAt).getTime() <= now.getTime()) {
    return false;
  }

  if (context.risk === "HIGH" && envelope.riskCeiling !== "HIGH") {
    return false;
  }

  if (
    envelope.maxOperations != null &&
    context.currentOperationCount != null &&
    context.currentOperationCount >= envelope.maxOperations
  ) {
    return false;
  }

  if (envelope.allowedPaths && envelope.allowedPaths.length > 0) {
    if (context.path == null || !envelope.allowedPaths.includes(context.path)) return false;
  }

  if (envelope.allowedApiMethods && envelope.allowedApiMethods.length > 0) {
    if (context.apiMethod == null || !envelope.allowedApiMethods.includes(context.apiMethod)) return false;
  }

  if (envelope.allowedServiceActions && envelope.allowedServiceActions.length > 0) {
    if (context.serviceAction == null || !envelope.allowedServiceActions.includes(context.serviceAction)) return false;
  }

  if (envelope.allowedGitActions && envelope.allowedGitActions.length > 0) {
    if (context.gitAction == null || !envelope.allowedGitActions.includes(context.gitAction)) return false;
  }

  return true;
}

/**
 * ---------------------------------------------------------------------
 * Phase 2 PoC: tool-gateway enforcement for the NEXORA-authored local
 * Google Sheets MCP server (`append_rows` / `update_values` only).
 *
 * This is deliberately NOT built on top of `isActionWithinEnvelope()` above
 * — that function speaks heartbeat's risk vocabulary (LOW/HIGH) for a
 * task-level gate that this design explicitly does not wire into
 * heartbeat.ts (LOW already auto-passes there today; an envelope would add
 * no relief). The real repeated-approval friction lives in tool-gateway's
 * per-call `require_approval` policy gate, which uses a different risk
 * vocabulary (`toolCatalogEntries.riskLevel`: read/write/destructive) and a
 * different unit of authorization (one tool call, not one task). Forcing
 * both layers through the same function would blur two genuinely different
 * trust boundaries — see the Phase 2 design history in `doc/plans/`.
 * ---------------------------------------------------------------------
 */

const SUPPORTED_GOOGLE_SHEETS_TOOL_NAMES = new Set(["append_rows", "update_values"]);

interface TrustedGoogleSheetsTool {
  catalogEntryId: string;
  toolName: "append_rows" | "update_values";
}

/**
 * Resolves and trust-verifies a tool call's identity entirely from
 * server-side records — never from the tool name string alone (the same
 * name can arrive from an unrelated MCP connection) and never from
 * anything the agent's call itself claims. A tool is eligible only if:
 * the exact `toolCatalogEntries` row is one of the two supported names,
 * is `active` (not quarantined/disabled), is catalogued as `"write"` risk
 * (never destructive), AND its owning connection is transport
 * `"local_stdio"` with `config.sourceTemplateKey === "google-sheets"` —
 * the same connection-identity field `classifyRisk()` already uses
 * elsewhere in this codebase for its Notion override, not a new field
 * invented for this PoC.
 */
async function resolveTrustedGoogleSheetsTool(
  db: Db,
  input: { toolCatalogEntryId: string; toolName: string },
): Promise<TrustedGoogleSheetsTool | null> {
  if (!SUPPORTED_GOOGLE_SHEETS_TOOL_NAMES.has(input.toolName)) return null;

  const [row] = await db
    .select({
      id: toolCatalogEntries.id,
      name: toolCatalogEntries.name,
      status: toolCatalogEntries.status,
      riskLevel: toolCatalogEntries.riskLevel,
      connectionConfig: toolConnections.config,
      transport: toolConnections.transport,
    })
    .from(toolCatalogEntries)
    .innerJoin(toolConnections, eq(toolConnections.id, toolCatalogEntries.connectionId))
    .where(and(
      eq(toolCatalogEntries.id, input.toolCatalogEntryId),
      eq(toolCatalogEntries.name, input.toolName),
    ))
    .limit(1);

  if (!row) return null;
  if (row.status !== "active") return null;
  if (row.riskLevel !== "write") return null;
  if (row.transport !== "local_stdio") return null;
  const sourceTemplateKey = (row.connectionConfig as Record<string, unknown> | null)?.sourceTemplateKey;
  if (sourceTemplateKey !== "google-sheets") return null;

  return { catalogEntryId: row.id, toolName: input.toolName as "append_rows" | "update_values" };
}

export interface GoogleSheetsScope {
  spreadsheetId: string;
  sheetName: string;
}

/**
 * Extracts `{spreadsheetId, sheetName}` from the tool's own real call
 * arguments — never from task text. Fails closed (returns null) whenever
 * the sheet name cannot be determined with certainty: no `range`, no `!`
 * separator, or malformed quoting. Sheet-name comparison by callers must
 * always be exact-string equality, never a prefix check — `"Sheet1"` must
 * never match an allow-list entry for `"Sheet10"`.
 */
export function extractGoogleSheetsScope(parameters: unknown): GoogleSheetsScope | null {
  if (typeof parameters !== "object" || parameters === null) return null;
  const record = parameters as Record<string, unknown>;
  const spreadsheetId = typeof record.spreadsheetId === "string" ? record.spreadsheetId.trim() : "";
  const range = typeof record.range === "string" ? record.range.trim() : "";
  if (!spreadsheetId || !range) return null;

  const bangIndex = range.indexOf("!");
  if (bangIndex <= 0) return null;

  let sheetName = range.slice(0, bangIndex).trim();
  if (sheetName.startsWith("'")) {
    if (!sheetName.endsWith("'") || sheetName.length < 2) return null;
    sheetName = sheetName.slice(1, -1);
  }
  if (!sheetName) return null;

  return { spreadsheetId, sheetName };
}

/**
 * Server-generated identity for one consumption slot. Never accepts a
 * fingerprint from the agent/caller — always computed here from the
 * trusted tool identity and the tool's own canonicalized arguments.
 */
export function computeEnvelopeActionFingerprint(input: {
  toolCatalogEntryId: string;
  canonicalParameters: unknown;
}): string {
  const canonical = JSON.stringify({
    toolCatalogEntryId: input.toolCatalogEntryId,
    parameters: input.canonicalParameters,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

class EnvelopeRaceLostError extends Error {}

export type AuthorizeAndConsumeEnvelopeOutcome =
  | { outcome: "allowed"; envelopeId: string }
  | { outcome: "denied"; reason: string };

/**
 * The single function responsible for the final ALLOW/DENY decision on a
 * Google Sheets `append_rows`/`update_values` call, and — only on ALLOW —
 * for atomically consuming one unit of the matched envelope's operation
 * budget. DENY here means only "no envelope relief available"; the caller
 * (tool-gateway) must fall through to the existing, completely unmodified
 * `require_approval` flow — it never means "block execution outright".
 *
 * Every DB-backed fact (not revoked, not expired, budget remaining, this
 * exact action not already consumed by this run) is re-verified inside the
 * same atomic transaction that records the consumption, so nothing can
 * change between the check and the consume.
 */
export async function authorizeAndConsumeEnvelope(
  db: Db,
  input: {
    companyId: string;
    issueId: string | null;
    agentId: string | null;
    runId: string | null;
    toolCatalogEntryId: string;
    toolName: string;
    parameters: unknown;
    now?: Date;
  },
): Promise<AuthorizeAndConsumeEnvelopeOutcome> {
  if (!input.issueId || !input.agentId || !input.runId) {
    return { outcome: "denied", reason: "missing_execution_context" };
  }

  const trustedTool = await resolveTrustedGoogleSheetsTool(db, {
    toolCatalogEntryId: input.toolCatalogEntryId,
    toolName: input.toolName,
  });
  if (!trustedTool) {
    return { outcome: "denied", reason: "unsupported_or_untrusted_tool" };
  }

  const scope = extractGoogleSheetsScope(input.parameters);
  if (!scope) {
    return { outcome: "denied", reason: "scope_extraction_failed" };
  }

  const now = input.now ?? new Date();
  const issueId = input.issueId;
  const agentId = input.agentId;
  const runId = input.runId;

  const candidates = await db
    .select()
    .from(taskAuthorizationEnvelopes)
    .where(and(
      eq(taskAuthorizationEnvelopes.companyId, input.companyId),
      eq(taskAuthorizationEnvelopes.issueId, issueId),
      eq(taskAuthorizationEnvelopes.agentId, agentId),
      isNull(taskAuthorizationEnvelopes.revokedAt),
      gt(taskAuthorizationEnvelopes.expiresAt, now),
    ));

  const matched = candidates.find((envelope) => {
    if (envelope.level !== "safe_mutation") return false;
    if (envelope.riskCeiling !== "LOW") return false;
    const resources = Array.isArray(envelope.allowedResources) ? envelope.allowedResources : [];
    return resources.some((resource) => {
      const r = resource as Record<string, unknown>;
      return (
        r.type === "google_sheet" &&
        r.spreadsheetId === scope.spreadsheetId &&
        typeof r.sheetName === "string" &&
        r.sheetName === scope.sheetName
      );
    });
  });

  if (!matched) {
    return { outcome: "denied", reason: "no_matching_envelope" };
  }

  const actionFingerprint = computeEnvelopeActionFingerprint({
    toolCatalogEntryId: trustedTool.catalogEntryId,
    canonicalParameters: input.parameters,
  });

  try {
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(taskAuthorizationEnvelopeConsumptions)
        .values({ envelopeId: matched.id, runId, actionFingerprint })
        .onConflictDoNothing()
        .returning();

      if (inserted.length === 0) {
        // Identical (envelope, run, action) already consumed — idempotent retry.
        return;
      }

      const [updated] = await tx
        .update(taskAuthorizationEnvelopes)
        .set({
          operationsConsumed: sql`${taskAuthorizationEnvelopes.operationsConsumed} + 1`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(taskAuthorizationEnvelopes.id, matched.id),
          eq(taskAuthorizationEnvelopes.companyId, input.companyId),
          eq(taskAuthorizationEnvelopes.issueId, issueId),
          eq(taskAuthorizationEnvelopes.agentId, agentId),
          isNull(taskAuthorizationEnvelopes.revokedAt),
          gt(taskAuthorizationEnvelopes.expiresAt, now),
          or(
            isNull(taskAuthorizationEnvelopes.maxOperations),
            lt(taskAuthorizationEnvelopes.operationsConsumed, taskAuthorizationEnvelopes.maxOperations),
          ),
        ))
        .returning();

      if (!updated) {
        // Revoked/expired/exhausted concurrently since the pre-check above —
        // roll back the consumption claim inserted just above in this same
        // transaction.
        throw new EnvelopeRaceLostError();
      }
    });
  } catch (err) {
    if (err instanceof EnvelopeRaceLostError) {
      return { outcome: "denied", reason: "expired_or_revoked_or_exhausted" };
    }
    throw err;
  }

  return { outcome: "allowed", envelopeId: matched.id };
}
