CREATE TABLE "approval_action_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_identity" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"approval_id" uuid NOT NULL,
	"action" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"http_status" integer,
	"response_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approval_action_idempotency_keys_status_check" CHECK ("approval_action_idempotency_keys"."status" in ('reserved', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "approval_action_idempotency_keys" ADD CONSTRAINT "approval_action_idempotency_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_action_idempotency_keys" ADD CONSTRAINT "approval_action_idempotency_keys_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_action_idempotency_keys_actor_key_uq" ON "approval_action_idempotency_keys" USING btree ("actor_identity","idempotency_key");--> statement-breakpoint
CREATE INDEX "approval_action_idempotency_keys_company_expires_at_idx" ON "approval_action_idempotency_keys" USING btree ("company_id","expires_at");