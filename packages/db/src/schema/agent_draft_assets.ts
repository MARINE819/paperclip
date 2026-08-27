import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { approvals } from "./approvals.js";

export const agentDraftAssets = pgTable(
  "agent_draft_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    
    assetType: text("asset_type").notNull(), // 'memory', 'skill', 'library'
    status: text("status").notNull().default("candidate"), // 'candidate', 'qa_passed', 'qa_failed', 'approved', 'rejected'
    
    content: jsonb("content").notNull(),
    
    qaAgentId: uuid("qa_agent_id").references(() => agents.id, { onDelete: "set null" }),
    qaNotes: text("qa_notes"),
    
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("agent_draft_assets_company_status_idx").on(table.companyId, table.status),
    agentIdx: index("agent_draft_assets_agent_idx").on(table.agentId),
  })
);
