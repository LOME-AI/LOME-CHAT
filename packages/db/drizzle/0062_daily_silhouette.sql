ALTER TABLE "usage_records" RENAME COLUMN "user_id" TO "payer_user_id";--> statement-breakpoint
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "usage_records_user_id_idx";--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_records_payer_user_id_idx" ON "usage_records" USING btree ("payer_user_id") WHERE "usage_records"."payer_user_id" is not null;