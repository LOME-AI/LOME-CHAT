ALTER TABLE "usage_records" ADD COLUMN "sender_user_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "sender_link_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_sender_link_id_shared_links_id_fk" FOREIGN KEY ("sender_link_id") REFERENCES "public"."shared_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_records_sender_user_id_idx" ON "usage_records" USING btree ("sender_user_id") WHERE "usage_records"."sender_user_id" is not null;--> statement-breakpoint
CREATE INDEX "usage_records_sender_link_id_idx" ON "usage_records" USING btree ("sender_link_id") WHERE "usage_records"."sender_link_id" is not null;