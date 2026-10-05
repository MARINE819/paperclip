CREATE TABLE "runtime_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"source" text NOT NULL,
	"instance_id" text DEFAULT 'default' NOT NULL,
	"affected_components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed_state" jsonb,
	"expected_state" jsonb,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"related_pid" text,
	"related_run_id" text,
	"recovery_attempted" boolean DEFAULT false NOT NULL,
	"recovery_result" text,
	"root_cause" text,
	"root_cause_status" text DEFAULT 'unknown' NOT NULL,
	"failure_memory_candidate" boolean DEFAULT false NOT NULL,
	"failure_memory_draft" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_incidents_open_fingerprint_idx" ON "runtime_incidents" USING btree ("instance_id","fingerprint") WHERE "runtime_incidents"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "runtime_incidents_status_idx" ON "runtime_incidents" USING btree ("instance_id","status");--> statement-breakpoint
CREATE INDEX "runtime_incidents_code_idx" ON "runtime_incidents" USING btree ("instance_id","code");--> statement-breakpoint
CREATE INDEX "runtime_incidents_detected_at_idx" ON "runtime_incidents" USING btree ("instance_id","detected_at");