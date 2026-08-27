ALTER TABLE "approvals" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "task_fingerprint" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "consumed_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "superseded_by_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_consumed_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("consumed_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_superseded_by_approval_id_approvals_id_fk" FOREIGN KEY ("superseded_by_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_company_fingerprint_idx" ON "approvals" USING btree ("company_id","task_fingerprint");
--> statement-breakpoint
-- Legacy backfill (Option A, Human-approved 2026-08-27): existing pending
-- Risk Guard approvals get a TTL measured from their original createdAt, not
-- from migration-apply time. This intentionally expires already-stale
-- outstanding HIGH/UNKNOWN approvals immediately on apply (see
-- docs/investigations/mobile-remote-approval-lifecycle-security-implementation.md).
UPDATE "approvals"
SET
  "task_fingerprint" = payload->>'taskFingerprint',
  "expires_at" = "created_at" + interval '15 minutes'
WHERE
  "type" = 'request_board_approval'
  AND "status" IN ('pending', 'revision_requested')
  AND payload->>'source' = 'risk_guard'
  AND payload->>'taskFingerprint' IS NOT NULL;