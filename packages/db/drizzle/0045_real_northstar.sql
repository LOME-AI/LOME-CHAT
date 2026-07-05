ALTER TABLE "content_items" DROP CONSTRAINT "content_items_model_catalog_id_model_catalog_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_model_catalog_id_model_catalog_id_fk";
--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."ledger_entry_kind";--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_kind" AS ENUM('deposit', 'charge', 'clawback', 'promo', 'refund');--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "kind" SET DATA TYPE "public"."ledger_entry_kind" USING "kind"::"public"."ledger_entry_kind";--> statement-breakpoint
DROP INDEX "content_items_model_catalog_id_idx";--> statement-breakpoint
DROP INDEX "usage_records_model_catalog_id_idx";--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "provider_name" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "model_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "provider_name" text NOT NULL;--> statement-breakpoint
CREATE INDEX "content_items_model_id_idx" ON "content_items" USING btree ("model_id") WHERE "content_items"."model_id" is not null;--> statement-breakpoint
CREATE INDEX "usage_records_model_id_idx" ON "usage_records" USING btree ("model_id");--> statement-breakpoint
ALTER TABLE "content_items" DROP COLUMN "model_catalog_id";--> statement-breakpoint
ALTER TABLE "usage_records" DROP COLUMN "model_catalog_id";