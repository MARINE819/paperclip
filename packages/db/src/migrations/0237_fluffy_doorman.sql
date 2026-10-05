ALTER TABLE "plugins" ADD COLUMN "risk_level" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "trust_status" text DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "requested_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "approved_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "signature_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "reviewed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN "signature_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_catalog_entries" ADD COLUMN "source_url" text;--> statement-breakpoint
CREATE INDEX "plugins_trust_status_idx" ON "plugins" USING btree ("trust_status");