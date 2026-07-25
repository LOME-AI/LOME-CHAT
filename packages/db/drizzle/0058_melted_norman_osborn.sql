ALTER TYPE "public"."device_platform" ADD VALUE 'web';--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"global_enabled" boolean DEFAULT true NOT NULL,
	"messages" boolean DEFAULT true NOT NULL,
	"run_completion" boolean DEFAULT true NOT NULL,
	"membership" boolean DEFAULT true NOT NULL,
	"quiet_hours_start_minutes" integer,
	"quiet_hours_end_minutes" integer,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "notification_preferences_quiet_hours_both_or_neither" CHECK (("notification_preferences"."quiet_hours_start_minutes" IS NULL) = ("notification_preferences"."quiet_hours_end_minutes" IS NULL)),
	CONSTRAINT "notification_preferences_quiet_hours_timezone" CHECK ("notification_preferences"."quiet_hours_start_minutes" IS NULL OR "notification_preferences"."timezone" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "last_read_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD COLUMN "p256dh" text;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD COLUMN "auth" text;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_web_keys_present" CHECK (("device_tokens"."platform"::text = 'web') = ("device_tokens"."p256dh" IS NOT NULL) AND ("device_tokens"."platform"::text = 'web') = ("device_tokens"."auth" IS NOT NULL));