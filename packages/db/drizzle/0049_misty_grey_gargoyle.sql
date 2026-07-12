ALTER TABLE "shared_messages" DROP CONSTRAINT "shared_messages_link_id_shared_links_id_fk";
--> statement-breakpoint
DROP INDEX "shared_messages_link_id_idx";--> statement-breakpoint
ALTER TABLE "shared_messages" DROP COLUMN "link_id";