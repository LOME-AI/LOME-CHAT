CREATE TYPE "public"."newsletter_consent_source" AS ENUM('marketing_site', 'app_settings');--> statement-breakpoint
CREATE TYPE "public"."newsletter_delivery_status" AS ENUM('claimed', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."newsletter_issue_status" AS ENUM('scheduled', 'canceled', 'sending', 'sent');--> statement-breakpoint
CREATE TYPE "public"."newsletter_status" AS ENUM('pending', 'subscribed', 'unsubscribed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."newsletter_suppress_reason" AS ENUM('bounce', 'complaint');--> statement-breakpoint
CREATE TABLE "newsletter_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"issue_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"status" "newsletter_delivery_status" NOT NULL,
	"resend_email_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_deliveries_issue_id_subscriber_id_unique" UNIQUE("issue_id","subscriber_id")
);
--> statement-breakpoint
CREATE TABLE "newsletter_issues" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject" text NOT NULL,
	"body_markdown" text NOT NULL,
	"status" "newsletter_issue_status" NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"canceled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"recipient_count" integer,
	"sent_count" integer,
	"failed_count" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "newsletter_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"topic" text DEFAULT 'general' NOT NULL,
	"status" "newsletter_status" NOT NULL,
	"user_id" uuid,
	"consent_source" "newsletter_consent_source" NOT NULL,
	"consent_ip" text NOT NULL,
	"consent_text_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"suppressed_at" timestamp with time zone,
	"suppress_reason" "newsletter_suppress_reason",
	"confirm_token" text,
	"confirm_expires_at" timestamp with time zone,
	"confirm_sent_at" timestamp with time zone,
	"unsubscribe_token" text NOT NULL,
	CONSTRAINT "newsletter_subscribers_confirm_token_unique" UNIQUE("confirm_token"),
	CONSTRAINT "newsletter_subscribers_unsubscribe_token_unique" UNIQUE("unsubscribe_token"),
	CONSTRAINT "newsletter_subscribers_email_topic_unique" UNIQUE("email","topic")
);
--> statement-breakpoint
ALTER TABLE "newsletter_deliveries" ADD CONSTRAINT "newsletter_deliveries_issue_id_newsletter_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."newsletter_issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_deliveries" ADD CONSTRAINT "newsletter_deliveries_subscriber_id_newsletter_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."newsletter_subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD CONSTRAINT "newsletter_subscribers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "newsletter_deliveries_issue_id_idx" ON "newsletter_deliveries" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "newsletter_deliveries_subscriber_id_idx" ON "newsletter_deliveries" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "newsletter_subscribers_user_id_idx" ON "newsletter_subscribers" USING btree ("user_id");--> statement-breakpoint
-- Carve-out: newsletter_subscribers carries bearer-token material
-- (confirm_token grants the double-opt-in confirm, unsubscribe_token grants
-- the one-click unsubscribe) plus subscriber PII (email, consent_ip), so the
-- whole table is never panel-readable — packages/db credential-carve-out
-- rule; precedent: the full-table verification_tokens REVOKE in 0050. The
-- table is created by this migration, so 0050's ALTER DEFAULT PRIVILEGES
-- granted the panel its read; this REVOKE removes it. Customer-360 reads go
-- through the audited admin operations engine instead.
REVOKE SELECT ON newsletter_subscribers FROM admin_sql_panel;
