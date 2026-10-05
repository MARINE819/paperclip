CREATE TABLE "data_lifecycle_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_class" text NOT NULL,
	"retention_mode" text DEFAULT 'retain' NOT NULL,
	"retention_days" integer,
	"archive_after_days" integer,
	"hard_delete_after_days" integer,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'admin_configured' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "data_lifecycle_policies_data_class_uq" ON "data_lifecycle_policies" USING btree ("data_class");