import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// F-04 Agent Eval / Simulation Lab — instance-global (not company-scoped):
// a benchmark case is a platform-level quality test definition, run against
// arbitrary providers/models/agents for comparison, not a tenant's business
// data. See docs/contracts/nexora-f04-eval-api.md and
// docs/investigations/nexora-f04-agent-eval-simulation-lab-report.md.
export const evalBenchmarkCases = pgTable(
  "eval_benchmark_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stable identity across versions — e.g. "sql-query-fix". Regression
    // comparison groups runs by (key, version): a version bump means the
    // task definition changed, so results from different versions are
    // never silently compared against each other.
    key: text("key").notNull(),
    version: integer("version").notNull().default(1),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").notNull().default("general"),
    // The task input given to the agent/model under test (prompt, fixture
    // references, setup instructions) — opaque to this table, interpreted
    // by whatever actually drives the run (out of scope for this phase).
    taskDefinition: jsonb("task_definition").$type<Record<string, unknown>>().notNull(),
    // Ordered list of deterministic validator specs
    // ({type, ...type-specific params}) to run against a completed run's
    // result, evaluated before any optional LLM judge — see
    // eval-validators.ts.
    validatorSpec: jsonb("validator_spec").$type<Record<string, unknown>[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyVersionIdx: uniqueIndex("eval_benchmark_cases_key_version_idx").on(table.key, table.version),
  }),
);
