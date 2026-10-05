import { type AnyPgColumn, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { evalBenchmarkCases } from "./eval_benchmark_cases.js";

// F-04 Agent Eval / Simulation Lab — one execution of a benchmark case
// against a specific provider/model (optionally a real configured agent).
// Instance-global, same rationale as eval_benchmark_cases. See
// docs/contracts/nexora-f04-eval-api.md.
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => evalBenchmarkCases.id),
    // Denormalized at creation time from the benchmark case, so a later
    // edit/version-bump of the benchmark never silently reclassifies a
    // historical run, and so list/summary queries avoid a join for the two
    // fields they display most.
    benchmarkKey: text("benchmark_key").notNull(),
    benchmarkVersion: integer("benchmark_version").notNull(),
    // Nullable: an eval can target a raw provider/model with no company
    // agent involved at all (pure model comparison), or a specific
    // configured agent when relevant.
    agentId: uuid("agent_id").references(() => agents.id),
    modelProvider: text("model_provider").notNull(),
    modelName: text("model_name").notNull(),
    status: text("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    success: text("success"), // "true" | "false" | null (unknown/not yet determined) — kept nullable-tri-state, not boolean
    accuracy: numeric("accuracy", { precision: 5, scale: 4 }), // 0..1
    latencyMs: integer("latency_ms"),
    tokenUsage: jsonb("token_usage").$type<{ input?: number; output?: number; total?: number }>(),
    costEstimated: numeric("cost_estimated", { precision: 12, scale: 6 }),
    costActual: numeric("cost_actual", { precision: 12, scale: 6 }),
    failureType: text("failure_type"),
    retryCount: integer("retry_count").notNull().default(0),
    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => evalRuns.id, { onDelete: "set null" }),
    evidence: jsonb("evidence").$type<Record<string, unknown>[]>().notNull().default([]),
    // Ordered results from eval-validators.ts: deterministic checks always
    // run first; an optional LLM judge result (deterministic:false) may
    // also appear here but is never sufficient on its own to mark a run
    // "passed" — see computeEvalRunStatus in eval-engine.ts.
    validatorResults: jsonb("validator_results").$type<Record<string, unknown>[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskCreatedIdx: index("eval_runs_task_created_idx").on(table.taskId, table.createdAt),
    benchmarkKeyVersionCreatedIdx: index("eval_runs_benchmark_key_version_created_idx").on(
      table.benchmarkKey,
      table.benchmarkVersion,
      table.createdAt,
    ),
    providerModelIdx: index("eval_runs_provider_model_idx").on(table.modelProvider, table.modelName),
    statusIdx: index("eval_runs_status_idx").on(table.status),
    retryOfIdx: index("eval_runs_retry_of_idx").on(table.retryOfRunId),
  }),
);
