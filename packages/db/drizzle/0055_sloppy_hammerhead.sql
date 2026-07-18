CREATE TABLE "public_stats_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"schema_version" integer NOT NULL,
	"stats" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "public_stats_snapshots_created_at_idx" ON "public_stats_snapshots" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_records_created_at_idx" ON "usage_records" USING btree ("created_at");