ALTER TABLE "model_overrides" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_pricing" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "model_overrides" CASCADE;--> statement-breakpoint
DROP TABLE "model_pricing" CASCADE;--> statement-breakpoint
ALTER TABLE "model_catalog" DROP CONSTRAINT "model_catalog_model_version_unique";--> statement-breakpoint
ALTER TABLE "model_catalog" DROP COLUMN "version";--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_model_id_unique" UNIQUE("model_id");