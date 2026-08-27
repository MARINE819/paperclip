import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { approvals } from "./approvals.js";

export const approvalActionIdempotencyKeys = pgTable(
  "approval_action_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // "board_key:<keyId>" for a paired device/CLI key, "user:<userId>" for a
    // session/local_implicit board actor. Never the raw bearer token or hash.
    actorIdentity: text("actor_identity").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id, { onDelete: "cascade" }),
    action: text("action").notNull(), // "approve" | "reject" | "request_revision"
    // sha256 of the decision-relevant request fields (decisionNote today) —
    // never the raw note text duplicated into this table.
    requestFingerprint: text("request_fingerprint").notNull(),
    // "reserved": the claiming INSERT has run but the same transaction's
    // completing UPDATE has not (yet). No OTHER transaction can ever observe
    // a row in this state (Postgres MVCC hides it until commit, and the same
    // transaction always completes it before committing) — this column
    // exists as a defensive/observability invariant, not a state any caller
    // branches on: a row found with status="reserved" whose createdAt is not
    // "just now" would indicate a bug (a code path that claimed but never
    // completed), and is queryable/alertable specifically because this
    // column is explicit.
    // "completed": the transaction ran resolveApproval/requestRevision and
    // recorded the outcome — httpStatus/responseBody/completedAt are then
    // always set together, atomically, with the approval state change.
    status: text("status").notNull().default("reserved"),
    httpStatus: integer("http_status"),
    responseBody: text("response_body"), // JSON-serialized, already-redacted response
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Set at insert time (createdAt + retention window) so the cleanup sweep
    // is a plain indexed `expiresAt <= now()` scan, not a recomputation.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    // The row that makes "claim the key" atomic and exclusive per actor —
    // also the lookup index every read (fast-path check, and the loser's
    // re-select after losing the claim race) uses.
    actorKeyIdx: uniqueIndex("approval_action_idempotency_keys_actor_key_uq").on(
      table.actorIdentity,
      table.idempotencyKey,
    ),
    companyExpiresAtIdx: index("approval_action_idempotency_keys_company_expires_at_idx").on(
      table.companyId,
      table.expiresAt,
    ),
    statusCheck: check(
      "approval_action_idempotency_keys_status_check",
      sql`${table.status} in ('reserved', 'completed')`,
    ),
  }),
);
