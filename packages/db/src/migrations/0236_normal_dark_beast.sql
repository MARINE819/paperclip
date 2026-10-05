CREATE TABLE "eval_benchmark_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'general' NOT NULL,
	"task_definition" jsonb NOT NULL,
	"validator_spec" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"benchmark_key" text NOT NULL,
	"benchmark_version" integer NOT NULL,
	"agent_id" uuid,
	"model_provider" text NOT NULL,
	"model_name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"success" text,
	"accuracy" numeric(5, 4),
	"latency_ms" integer,
	"token_usage" jsonb,
	"cost_estimated" numeric(12, 6),
	"cost_actual" numeric(12, 6),
	"failure_type" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"retry_of_run_id" uuid,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validator_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_task_id_eval_benchmark_cases_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."eval_benchmark_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_retry_of_run_id_eval_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_benchmark_cases_key_version_idx" ON "eval_benchmark_cases" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "eval_runs_task_created_idx" ON "eval_runs" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_runs_benchmark_key_version_created_idx" ON "eval_runs" USING btree ("benchmark_key","benchmark_version","created_at");--> statement-breakpoint
CREATE INDEX "eval_runs_provider_model_idx" ON "eval_runs" USING btree ("model_provider","model_name");--> statement-breakpoint
CREATE INDEX "eval_runs_status_idx" ON "eval_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "eval_runs_retry_of_idx" ON "eval_runs" USING btree ("retry_of_run_id");