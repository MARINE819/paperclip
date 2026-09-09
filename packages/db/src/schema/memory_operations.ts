import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
  real,
} from "drizzle-orm/pg-core";
import type {
  MemorySourceType,
  MemoryOperationStatus,
  MemoryReviewState,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";

export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceType: text("source_type").$type<MemorySourceType>().notNull(),
    sourceId: text("source_id").notNull(),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    sourceAgentId: uuid("source_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    summary: text("summary"),
    content: text("content").notNull(),
    confidence: real("confidence"),
    status: text("status")
      .$type<MemoryOperationStatus>()
      .notNull()
      .default("candidate"),
    reviewState: text("review_state")
      .$type<MemoryReviewState>()
      .notNull()
      .default("pending"),
    reviewedByAgentId: uuid("reviewed_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    reviewNotes: text("review_notes"),
    approvalId: uuid("approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    extractionKey: text("extraction_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("memory_operations_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    companySourceIssueIdx: index("memory_operations_company_source_issue_idx").on(
      table.companyId,
      table.sourceIssueId,
    ),
    companySourceRunIdx: index("memory_operations_company_source_run_idx").on(
      table.companyId,
      table.sourceRunId,
    ),
    companySourceAgentIdx: index("memory_operations_company_source_agent_idx").on(
      table.companyId,
      table.sourceAgentId,
    ),
    companySourceTypeSourceIdIdx: index("memory_operations_company_source_type_source_id_idx").on(
      table.companyId,
      table.sourceType,
      table.sourceId,
    ),
    companyExtractionKeyUq: uniqueIndex("memory_operations_company_extraction_key_uq")
      .on(table.companyId, table.extractionKey)
      .where(sql`${table.extractionKey} IS NOT NULL`),
  }),
);
