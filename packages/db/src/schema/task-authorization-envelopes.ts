import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * NEXORA Master 2 — Task Authorization Envelope Phase 2 (Google Sheets PoC).
 *
 * A board-issued, immutable pre-authorization for a specific agent to
 * perform a bounded set of low-risk tool actions on a specific issue
 * without a fresh Human Approval Gate decision for each one. See
 * `server/src/services/task-authorization-envelope.ts` for the atomic
 * authorize+consume logic and `packages/shared/src/validators/task-authorization-envelope.ts`
 * for the JSON contents' schema (level/riskCeiling/allowedResources/etc,
 * stored here as `allowedResources`).
 *
 * Deliberately independent of `issues`/`toolCatalogEntries`' own row
 * shapes — this table is never joined into `issueListSelect` or any
 * `IssueRow`-typed projection, so adding columns here can never repeat the
 * Phase 1 `IssueRow` TypeScript cascade.
 */
export const taskAuthorizationEnvelopes = pgTable(
  "task_authorization_envelopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    // Least-privilege binding: an envelope authorizes ONE specific agent, not
    // any agent that happens to work this issue — see design discussion in
    // doc/plans/ for why binding by issueId alone would be a privilege
    // escalation path.
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    level: text("level").notNull(),
    riskCeiling: text("risk_ceiling").notNull().default("LOW"),
    allowedResources: jsonb("allowed_resources").$type<Record<string, unknown>[]>().notNull().default([]),
    maxOperations: integer("max_operations"),
    operationsConsumed: integer("operations_consumed").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    issuedByUserId: text("issued_by_user_id").notNull(),
    // Revocation is a one-way kill switch, not a mutation of the envelope's
    // terms — there is deliberately no route that updates
    // level/riskCeiling/allowedResources/maxOperations/expiresAt after
    // creation. Widening an envelope always means a human issuing a new one.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("task_authorization_envelopes_company_idx").on(table.companyId),
    index("task_authorization_envelopes_issue_idx").on(table.issueId),
    index("task_authorization_envelopes_agent_idx").on(table.agentId),
  ],
);

/**
 * One row per (envelope, run, distinct action) actually consumed. The
 * uniqueness constraint is what makes `authorizeAndConsumeEnvelope` retry-safe:
 * a genuine retry of the identical action (same run, same actionFingerprint)
 * cannot insert a second row, so it can never burn a second unit of
 * `maxOperations`. A different action from the same run gets its own
 * fingerprint and its own independent authorization — a run is never
 * grandfathered into everything just because it was seen before.
 */
export const taskAuthorizationEnvelopeConsumptions = pgTable(
  "task_authorization_envelope_consumptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    envelopeId: uuid("envelope_id").notNull().references(() => taskAuthorizationEnvelopes.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    actionFingerprint: text("action_fingerprint").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("task_authorization_envelope_consumptions_uq").on(
      table.envelopeId,
      table.runId,
      table.actionFingerprint,
    ),
  ],
);
