import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // Lifecycle/safety fields (mobile remote-approval slice 2). All nullable —
    // every pre-existing row and every approval type that doesn't opt in
    // (hire_agent, approve_ceo_strategy, budget_override_required) keeps NULL
    // and behaves exactly as before. Only Risk Guard's request_board_approval
    // approvals populate these, once heartbeat.ts is updated in a separate,
    // explicitly-approved change (heartbeat.ts is protected; not touched here).
    //
    // taskFingerprint is the single source of truth once populated — it must
    // only ever be written together with payload.taskFingerprint in the same
    // INSERT (heartbeat.ts's approval-creation statement), never patched
    // separately, so the two copies can never diverge. Every read that makes
    // a security decision (fingerprint match, resolveApproval, effective
    // status) reads this column, never payload.taskFingerprint — the payload
    // copy exists only so the JSON stays self-describing for humans/audit UI.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    taskFingerprint: text("task_fingerprint"),
    // "Consumed" = the single execution run this approval authorizes.
    // consumeApproval() atomically consumes an approval for exactly one
    // runId: the FIRST successful consume wins and writes consumedAt /
    // consumedByRunId, and every later attempt is judged against that first
    // value. A retry from the SAME runId is the only case treated as an
    // idempotent success (it's the same execution re-asking, not new
    // authorization). ANY OTHER runId is rejected outright as
    // "already_consumed_other_run" — even if its taskFingerprint still
    // matches, a different run may never reuse an approval someone else's
    // run already consumed. consumedAt/consumedByRunId always hold the
    // first consumer's values and are never overwritten after that.
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    // onDelete: "set null" — heartbeat_runs rows are never deleted by any
    // route in this codebase today, so this practically never fires; it
    // exists only as the same defensive default heartbeat_runs.ts already
    // uses for its own retryOfRunId self-reference. If it ever did fire, the
    // audit trail is not lost: consumedAt (a plain timestamp, not an FK) and
    // any activityLog rows written at consume time keep their own point-in-
    // time copy of the run id independent of this live reference.
    consumedByRunId: uuid("consumed_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    // Self-referencing FK to the newer approval that replaced this one after
    // its fingerprint went stale (target content changed post-approval).
    // Lazy `(): AnyPgColumn => approvals.id` mirrors heartbeat_runs.ts's own
    // retryOfRunId pattern exactly — required because `approvals` is not yet
    // fully defined at this point in its own object literal, so the callback
    // defers evaluation instead of referencing the table eagerly.
    // onDelete: "set null" for the same reason as consumedByRunId — approvals
    // are never hard-deleted in this codebase; this is a defensive default,
    // and losing the pointer never deletes the row it lives on or erases
    // consumedAt/decidedAt/activityLog history for either approval.
    supersededByApprovalId: uuid("superseded_by_approval_id").references(
      (): AnyPgColumn => approvals.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusTypeIdx: index("approvals_company_status_type_idx").on(
      table.companyId,
      table.status,
      table.type,
    ),
    companyFingerprintIdx: index("approvals_company_fingerprint_idx").on(
      table.companyId,
      table.taskFingerprint,
    ),
  }),
);
