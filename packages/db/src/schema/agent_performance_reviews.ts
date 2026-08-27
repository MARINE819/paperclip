import { pgTable, uuid, text, timestamp, jsonb, doublePrecision, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentPerformanceReviews = pgTable(
  "agent_performance_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    evalPeriod: text("eval_period").notNull(), // e.g., '2026-08'
    
    // Dynamic metrics for task completion, quality, QA pass rate, rework/error rate,
    // collaboration, judgment, cost efficiency, safety compliance, human feedback, etc.
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default({}),
    
    overallScore: doublePrecision("overall_score").notNull().default(0),
    strengths: text("strengths"),
    areasForImprovement: text("areas_for_improvement"),
    
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentPeriodIdx: index("agent_perf_agent_period_idx").on(table.agentId, table.evalPeriod),
    companyIdx: index("agent_perf_company_idx").on(table.companyId),
  })
);
