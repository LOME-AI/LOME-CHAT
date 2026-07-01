CREATE TYPE "public"."banner_variant" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TABLE "banner_config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"variant" "banner_variant" DEFAULT 'info' NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banner_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"message_set_hash" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "banner_dismissals_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "banner_dismissals" ADD CONSTRAINT "banner_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;