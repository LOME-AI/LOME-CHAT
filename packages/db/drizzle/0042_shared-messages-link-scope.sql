ALTER TABLE "shared_messages" ADD COLUMN "link_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_messages" ADD CONSTRAINT "shared_messages_link_id_shared_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."shared_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_messages_link_id_idx" ON "shared_messages" USING btree ("link_id");