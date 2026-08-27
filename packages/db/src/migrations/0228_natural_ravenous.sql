CREATE TABLE "agent_draft_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"content" jsonb NOT NULL,
	"qa_agent_id" uuid,
	"qa_notes" text,
	"approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_performance_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"eval_period" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"overall_score" double precision DEFAULT 0 NOT NULL,
	"strengths" text,
	"areas_for_improvement" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"head_agent_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "org_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "rank" text;--> statement-breakpoint
ALTER TABLE "agent_draft_assets" ADD CONSTRAINT "agent_draft_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_draft_assets" ADD CONSTRAINT "agent_draft_assets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_draft_assets" ADD CONSTRAINT "agent_draft_assets_qa_agent_id_agents_id_fk" FOREIGN KEY ("qa_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_draft_assets" ADD CONSTRAINT "agent_draft_assets_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_performance_reviews" ADD CONSTRAINT "agent_performance_reviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_performance_reviews" ADD CONSTRAINT "agent_performance_reviews_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_id_org_units_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_draft_assets_company_status_idx" ON "agent_draft_assets" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "agent_draft_assets_agent_idx" ON "agent_draft_assets" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_perf_agent_period_idx" ON "agent_performance_reviews" USING btree ("agent_id","eval_period");--> statement-breakpoint
CREATE INDEX "agent_perf_company_idx" ON "agent_performance_reviews" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "org_units_company_idx" ON "org_units" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "org_units_parent_idx" ON "org_units" USING btree ("parent_id");
