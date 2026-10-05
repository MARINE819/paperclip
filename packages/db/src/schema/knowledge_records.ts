import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import type {
  KnowledgeRecordStatus,
  ObsidianSyncState,
  KnowledgeSyncState,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agents } from "./agents.js";
import { memoryOperations } from "./memory_operations.js";

export const knowledgeRecords = pgTable(
  "knowledge_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    knowledgeType: text("knowledge_type"),
    title: text("title").notNull(),
    summary: text("summary"),
    body: text("body").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    sourceMemoryOperationId: uuid("source_memory_operation_id").references(
      () => memoryOperations.id,
      { onDelete: "set null" },
    ),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    sourceAgentId: uuid("source_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    status: text("status")
      .$type<KnowledgeRecordStatus>()
      .notNull()
      .default("active"),
    obsidianPath: text("obsidian_path"),
    obsidianSyncState: text("obsidian_sync_state")
      .$type<ObsidianSyncState>()
      .notNull()
      .default("pending"),
    obsidianSyncError: text("obsidian_sync_error"),
    obsidianSyncedAt: timestamp("obsidian_synced_at", { withTimezone: true }),
    // F-08 Pluggable Knowledge Backend — generic counterparts of the four
    // obsidian* columns above, written alongside them during this
    // compatibility phase (additive only; the obsidian* columns are not
    // renamed or dropped). See
    // docs/contracts/nexora-f08-knowledge-backend-architecture.md.
    externalBackendId: text("external_backend_id"),
    externalSyncState: text("external_sync_state").$type<KnowledgeSyncState>(),
    externalSyncError: text("external_sync_error"),
    externalSyncedAt: timestamp("external_synced_at", { withTimezone: true }),
    externalRef: text("external_ref"),
    // M2-03-B01 Knowledge Revision & Confidence Hardening — additive only.
    // confidence is carried through unchanged from memory_operations.confidence
    // at promotion time (see knowledge.ts promoteMemoryOperation) and is never
    // auto-increased by a later revision that lacks independent new evidence.
    confidence: real("confidence"),
    // revisionNumber starts at 1 on every row (existing pre-B01 rows are valid
    // as "revision 1 of themselves" with no backfill needed). latestRevisionId
    // is nullable only until the one-time backfill described in the batch
    // report; every row created from this point forward sets it in the same
    // transaction as the row itself.
    latestRevisionId: uuid("latest_revision_id"),
    revisionNumber: integer("revision_number").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("knowledge_records_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    companyCreatedAtIdx: index("knowledge_records_company_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
    companySourceIssueIdx: index("knowledge_records_company_source_issue_idx").on(
      table.companyId,
      table.sourceIssueId,
    ),
    titleSearchIdx: index("knowledge_records_title_search_idx").using(
      "gin",
      table.title.op("gin_trgm_ops"),
    ),
    bodySearchIdx: index("knowledge_records_body_search_idx").using(
      "gin",
      table.body.op("gin_trgm_ops"),
    ),
    sourceMemoryOperationUq: uniqueIndex("knowledge_records_source_mem_op_uq")
      .on(table.sourceMemoryOperationId)
      .where(sql`${table.sourceMemoryOperationId} IS NOT NULL`),
  }),
);
