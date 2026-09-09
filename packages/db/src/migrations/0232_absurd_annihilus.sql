
CREATE TABLE "knowledge_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"knowledge_type" text,
	"title" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_memory_operation_id" uuid,
	"source_issue_id" uuid,
	"source_run_id" uuid,
	"source_agent_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"obsidian_path" text,
	"obsidian_sync_state" text DEFAULT 'pending' NOT NULL,
	"obsidian_sync_error" text,
	"obsidian_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint

CREATE TABLE "memory_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_issue_id" uuid,
	"source_run_id" uuid,
	"source_agent_id" uuid,
	"title" text,
	"summary" text,
	"content" text NOT NULL,
	"confidence" real,
	"status" text DEFAULT 'candidate' NOT NULL,
	"review_state" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_agent_id" uuid,
	"review_notes" text,
	"approval_id" uuid,
	"extraction_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "knowledge_records" ADD CONSTRAINT "knowledge_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_records" ADD CONSTRAINT "knowledge_records_source_memory_operation_id_memory_operations_id_fk" FOREIGN KEY ("source_memory_operation_id") REFERENCES "public"."memory_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_records" ADD CONSTRAINT "knowledge_records_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_records" ADD CONSTRAINT "knowledge_records_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_records" ADD CONSTRAINT "knowledge_records_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_reviewed_by_agent_id_agents_id_fk" FOREIGN KEY ("reviewed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "knowledge_records_company_status_idx" ON "knowledge_records" USING btree ("company_id","status");--> statement-breakpoint

CREATE INDEX "knowledge_records_company_created_at_idx" ON "knowledge_records" USING btree ("company_id","created_at");--> statement-breakpoint

CREATE INDEX "knowledge_records_company_source_issue_idx" ON "knowledge_records" USING btree ("company_id","source_issue_id");--> statement-breakpoint

CREATE INDEX "knowledge_records_title_search_idx" ON "knowledge_records" USING gin ("title" gin_trgm_ops);--> statement-breakpoint

CREATE INDEX "knowledge_records_body_search_idx" ON "knowledge_records" USING gin ("body" gin_trgm_ops);--> statement-breakpoint

CREATE UNIQUE INDEX "knowledge_records_source_mem_op_uq" ON "knowledge_records" USING btree ("source_memory_operation_id") WHERE "knowledge_records"."source_memory_operation_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX "memory_operations_company_status_idx" ON "memory_operations" USING btree ("company_id","status");--> statement-breakpoint

CREATE INDEX "memory_operations_company_source_issue_idx" ON "memory_operations" USING btree ("company_id","source_issue_id");--> statement-breakpoint

CREATE INDEX "memory_operations_company_source_run_idx" ON "memory_operations" USING btree ("company_id","source_run_id");--> statement-breakpoint

CREATE INDEX "memory_operations_company_source_agent_idx" ON "memory_operations" USING btree ("company_id","source_agent_id");--> statement-breakpoint

CREATE INDEX "memory_operations_company_source_type_source_id_idx" ON "memory_operations" USING btree ("company_id","source_type","source_id");--> statement-breakpoint

CREATE UNIQUE INDEX "memory_operations_company_extraction_key_uq" ON "memory_operations" USING btree ("company_id","extraction_key") WHERE "memory_operations"."extraction_key" IS NOT NULL;