CREATE TYPE "public"."feedback_kind" AS ENUM('bug', 'idea', 'praise');--> statement-breakpoint
CREATE TYPE "public"."feedback_status" AS ENUM('new', 'triaged', 'resolved', 'wont_fix', 'spam');--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "feedback_kind" NOT NULL,
	"status" "feedback_status" DEFAULT 'new' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_user_id_idx" ON "feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "feedback_status_created_at_idx" ON "feedback" USING btree ("status","created_at");