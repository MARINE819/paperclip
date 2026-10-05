CREATE TABLE "task_authorization_envelope_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"envelope_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"action_fingerprint" text NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_authorization_envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"level" text NOT NULL,
	"risk_ceiling" text DEFAULT 'LOW' NOT NULL,
	"allowed_resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_operations" integer,
	"operations_consumed" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_authorization_envelope_consumptions" ADD CONSTRAINT "task_authorization_envelope_consumptions_envelope_id_task_authorization_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."task_authorization_envelopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_authorization_envelope_consumptions" ADD CONSTRAINT "task_authorization_envelope_consumptions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_authorization_envelopes" ADD CONSTRAINT "task_authorization_envelopes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_authorization_envelopes" ADD CONSTRAINT "task_authorization_envelopes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_authorization_envelopes" ADD CONSTRAINT "task_authorization_envelopes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_authorization_envelope_consumptions_uq" ON "task_authorization_envelope_consumptions" USING btree ("envelope_id","run_id","action_fingerprint");--> statement-breakpoint
CREATE INDEX "task_authorization_envelopes_company_idx" ON "task_authorization_envelopes" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "task_authorization_envelopes_issue_idx" ON "task_authorization_envelopes" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "task_authorization_envelopes_agent_idx" ON "task_authorization_envelopes" USING btree ("agent_id");