import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { DataLifecycleClass, DataLifecycleRetentionMode } from "@paperclipai/shared";

// F-01 Data Lifecycle / Data Governance — instance-wide policy configuration
// (not company-scoped: retention policy is an operator governance decision,
// not tenant data). One row per data class. This table intentionally ships
// with NO write API and NO seeded rows in this batch — every dry-run
// against an unconfigured class reports "no policy, fail-closed" until a
// separately-approved future batch decides real retention numbers. See
// docs/investigations/nexora-f01-data-lifecycle-report.md.
export const dataLifecyclePolicies = pgTable(
  "data_lifecycle_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataClass: text("data_class").$type<DataLifecycleClass>().notNull(),
    retentionMode: text("retention_mode").$type<DataLifecycleRetentionMode>().notNull().default("retain"),
    retentionDays: integer("retention_days"),
    archiveAfterDays: integer("archive_after_days"),
    hardDeleteAfterDays: integer("hard_delete_after_days"),
    // Class-wide preservation flag: while true, dry-run/cleanup for this
    // entire class always reports zero candidates, regardless of age or
    // retentionMode. This is the only legal-hold concept this batch
    // introduces — a per-record hold (e.g. one specific incident under
    // litigation) is a known, explicitly out-of-scope gap; see the report.
    legalHold: boolean("legal_hold").notNull().default(false),
    // Policies start disabled: an admin must explicitly enable one before
    // any dry-run treats it as active, even once real retentionDays values
    // exist.
    enabled: boolean("enabled").notNull().default(false),
    source: text("source").notNull().default("admin_configured"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dataClassUq: uniqueIndex("data_lifecycle_policies_data_class_uq").on(table.dataClass),
  }),
);
