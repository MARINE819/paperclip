ALTER TABLE "knowledge_records" ADD COLUMN "external_backend_id" text;--> statement-breakpoint
ALTER TABLE "knowledge_records" ADD COLUMN "external_sync_state" text;--> statement-breakpoint
ALTER TABLE "knowledge_records" ADD COLUMN "external_sync_error" text;--> statement-breakpoint
ALTER TABLE "knowledge_records" ADD COLUMN "external_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_records" ADD COLUMN "external_ref" text;