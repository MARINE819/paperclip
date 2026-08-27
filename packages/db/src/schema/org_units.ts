import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const orgUnits = pgTable(
  "org_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => orgUnits.id, { onDelete: "set null" }),
    headAgentId: uuid("head_agent_id"), // Cannot reference agents.id here directly to avoid circular dependency, but logically references agents.id
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("org_units_company_idx").on(table.companyId),
    parentIdx: index("org_units_parent_idx").on(table.parentId),
  })
);
