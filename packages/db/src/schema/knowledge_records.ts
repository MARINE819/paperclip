import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import type {
  KnowledgeRecordStatus,
  ObsidianSyncState,
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
