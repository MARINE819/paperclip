import { pgTable, uuid, text, integer, real, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { knowledgeRecords } from "./knowledge_records.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const knowledgeRecordRevisions = pgTable(
  "knowledge_record_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    knowledgeRecordId: uuid("knowledge_record_id").notNull().references(() => knowledgeRecords.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    knowledgeType: text("knowledge_type"),
    title: text("title").notNull(),
    summary: text("summary"),
    body: text("body").notNull(),
    confidence: real("confidence"),
    changeSummary: text("change_summary"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    knowledgeRecordRevisionUq: uniqueIndex("knowledge_record_revisions_record_revision_uq").on(
      table.knowledgeRecordId,
      table.revisionNumber,
    ),
    companyRecordCreatedIdx: index("knowledge_record_revisions_company_record_created_idx").on(
      table.companyId,
      table.knowledgeRecordId,
      table.createdAt,
    ),
  }),
);
