CREATE TABLE "knowledge_record_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"knowledge_record_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"knowledge_type" text,
	"title" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"confidence" real,
	"change_summary" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_records" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "knowledge_records" ADD COLUMN "latest_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_records" ADD COLUMN "revision_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_record_revisions" ADD CONSTRAINT "knowledge_record_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_record_revisions" ADD CONSTRAINT "knowledge_record_revisions_knowledge_record_id_knowledge_records_id_fk" FOREIGN KEY ("knowledge_record_id") REFERENCES "public"."knowledge_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_record_revisions" ADD CONSTRAINT "knowledge_record_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_record_revisions" ADD CONSTRAINT "knowledge_record_revisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_record_revisions_record_revision_uq" ON "knowledge_record_revisions" USING btree ("knowledge_record_id","revision_number");--> statement-breakpoint
CREATE INDEX "knowledge_record_revisions_company_record_created_idx" ON "knowledge_record_revisions" USING btree ("company_id","knowledge_record_id","created_at");