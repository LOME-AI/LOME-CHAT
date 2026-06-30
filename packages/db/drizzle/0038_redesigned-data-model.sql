CREATE TYPE "public"."content_item_type" AS ENUM('text', 'image', 'audio', 'video');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."house_account" AS ENUM('revenue', 'payments-in', 'promo');--> statement-breakpoint
CREATE TYPE "public"."idempotency_key_kind" AS ENUM('request', 'run');--> statement-breakpoint
CREATE TYPE "public"."idempotency_key_status" AS ENUM('claimed', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_shard" AS ENUM('default', 'bulk');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'cancelled', 'dead');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_kind" AS ENUM('deposit', 'charge', 'true_up', 'clawback', 'promo', 'refund');--> statement-breakpoint
CREATE TYPE "public"."member_privilege" AS ENUM('read', 'write', 'admin', 'owner');--> statement-breakpoint
CREATE TYPE "public"."message_sender_type" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."modality" AS ENUM('text', 'image', 'audio', 'video', 'embedding');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'awaiting_webhook', 'completed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."user_lock_reason" AS ENUM('chargeback', 'admin');--> statement-breakpoint
CREATE TYPE "public"."verification_purpose" AS ENUM('email_verification');--> statement-breakpoint
CREATE TYPE "public"."wallet_type" AS ENUM('purchased', 'free');--> statement-breakpoint
CREATE TABLE "admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allowance_spending" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowance_spending_user_day_unique" UNIQUE("user_id","day"),
	CONSTRAINT "allowance_spending_day_format" CHECK ("allowance_spending"."day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid NOT NULL,
	"content_type" "content_item_type" NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"encrypted_blob" "bytea",
	"storage_key" text,
	"mime_type" text,
	"size_bytes" integer,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"model_catalog_id" uuid,
	"cost_nano_usd" bigint,
	"is_smart_model" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_items_type_consistency" CHECK (
        ("content_items"."content_type" = 'text'
          AND "content_items"."encrypted_blob" IS NOT NULL
          AND "content_items"."storage_key" IS NULL
          AND "content_items"."mime_type" IS NULL
          AND "content_items"."size_bytes" IS NULL)
        OR ("content_items"."content_type" IN ('image', 'audio', 'video')
          AND "content_items"."storage_key" IS NOT NULL
          AND "content_items"."mime_type" IS NOT NULL
          AND "content_items"."size_bytes" IS NOT NULL
          AND "content_items"."encrypted_blob" IS NULL)
      )
);
--> statement-breakpoint
CREATE TABLE "conversation_forks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tip_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_forks_conversation_name_unique" UNIQUE("conversation_id","name")
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid,
	"link_id" uuid,
	"privilege" "member_privilege" DEFAULT 'write' NOT NULL,
	"visible_from_epoch" integer NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"muted" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"invited_by_user_id" uuid,
	CONSTRAINT "conversation_members_identity_or_left_check" CHECK ("conversation_members"."user_id" IS NOT NULL OR "conversation_members"."link_id" IS NOT NULL OR "conversation_members"."left_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "conversation_spending" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"month" text NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_spending_conversation_month_unique" UNIQUE("conversation_id","month"),
	CONSTRAINT "conversation_spending_month_format" CHECK ("conversation_spending"."month" ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" "bytea" NOT NULL,
	"title_epoch_number" integer DEFAULT 1 NOT NULL,
	"current_epoch" integer DEFAULT 1 NOT NULL,
	"next_sequence" integer DEFAULT 1 NOT NULL,
	"budget_nano_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_instructions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"encrypted_instructions" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_instructions_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "epoch_members" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"epoch_id" uuid NOT NULL,
	"member_public_key" "bytea" NOT NULL,
	"wrap" "bytea" NOT NULL,
	"visible_from_epoch" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "epoch_members_epoch_key_unique" UNIQUE("epoch_id","member_public_key")
);
--> statement-breakpoint
CREATE TABLE "epochs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"epoch_number" integer NOT NULL,
	"previous_epoch_id" uuid,
	"epoch_public_key" "bytea" NOT NULL,
	"confirmation_hash" "bytea" NOT NULL,
	"chain_link" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "epochs_conversation_epoch_unique" UNIQUE("conversation_id","epoch_number")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"kind" "idempotency_key_kind" NOT NULL,
	"status" "idempotency_key_status" DEFAULT 'claimed' NOT NULL,
	"body_hash" text NOT NULL,
	"response" jsonb,
	"run_id" uuid,
	"claims" integer DEFAULT 1 NOT NULL,
	"claimed_by" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_unique" UNIQUE("user_id","route","key")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"shard" "job_shard" DEFAULT 'default' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"dedupe_key" text,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"claims" integer DEFAULT 0 NOT NULL,
	"max_claims" integer NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"max_failures" integer NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"lease_seconds" integer NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"wallet_id" uuid,
	"house_account" "house_account",
	"kind" "ledger_entry_kind" NOT NULL,
	"amount_nano_usd" bigint NOT NULL,
	"balance_after_nano_usd" bigint,
	"idempotency_key" text NOT NULL,
	"payment_id" uuid,
	"usage_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ledger_entries_one_account" CHECK (num_nonnulls("ledger_entries"."wallet_id", "ledger_entries"."house_account") = 1),
	CONSTRAINT "ledger_entries_balance_on_wallet_legs" CHECK (("ledger_entries"."balance_after_nano_usd" IS NOT NULL) = ("ledger_entries"."wallet_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "llm_completions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"usage_record_id" uuid NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"tool_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "llm_completions_usage_record_id_unique" UNIQUE("usage_record_id")
);
--> statement-breakpoint
CREATE TABLE "media_generations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"usage_record_id" uuid NOT NULL,
	"modality" "modality" NOT NULL,
	"image_count" integer,
	"duration_ms" integer,
	"resolution" text,
	CONSTRAINT "media_generations_usage_record_id_unique" UNIQUE("usage_record_id")
);
--> statement-breakpoint
CREATE TABLE "member_budgets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"member_id" uuid NOT NULL,
	"month" text NOT NULL,
	"budget_nano_usd" bigint NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_budgets_member_month_unique" UNIQUE("member_id","month"),
	CONSTRAINT "member_budgets_month_format" CHECK ("member_budgets"."month" ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_type" "message_sender_type" NOT NULL,
	"sender_id" uuid,
	"wrapped_content_key" "bytea" NOT NULL,
	"epoch_number" integer NOT NULL,
	"sequence_number" integer NOT NULL,
	"parent_message_id" uuid,
	"batch_id" uuid DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_conversation_sequence_unique" UNIQUE("conversation_id","sequence_number")
);
--> statement-breakpoint
CREATE TABLE "model_catalog" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"model_id" text NOT NULL,
	"version" integer NOT NULL,
	"descriptor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_catalog_model_version_unique" UNIQUE("model_id","version")
);
--> statement-breakpoint
CREATE TABLE "model_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"model_id" text NOT NULL,
	"overrides" jsonb NOT NULL,
	"zdr_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_overrides_model_id_unique" UNIQUE("model_id")
);
--> statement-breakpoint
CREATE TABLE "model_pricing" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"model_catalog_id" uuid NOT NULL,
	"pricing" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"amount_nano_usd" bigint NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"helcim_transaction_id" text,
	"card_type" text,
	"card_last_four" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"webhook_received_at" timestamp with time zone,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payments_helcim_transaction_id_unique" UNIQUE("helcim_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"accessibility" jsonb DEFAULT '{"version":1}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "shared_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"link_public_key" "bytea" NOT NULL,
	"display_name" text,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_links_link_public_key_unique" UNIQUE("link_public_key")
);
--> statement-breakpoint
CREATE TABLE "shared_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"wrapped_content_key" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"content_item_id" uuid,
	"run_id" uuid NOT NULL,
	"model_catalog_id" uuid NOT NULL,
	"modality" "modality" NOT NULL,
	"generation_id" text,
	"cost_nano_usd" bigint NOT NULL,
	"is_estimated" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"username" varchar(20) NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"opaque_registration" "bytea" NOT NULL,
	"totp_secret_encrypted" "bytea",
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"has_acknowledged_phrase" boolean DEFAULT false NOT NULL,
	"public_key" "bytea" NOT NULL,
	"password_wrapped_private_key" "bytea" NOT NULL,
	"recovery_wrapped_private_key" "bytea" NOT NULL,
	"locked_at" timestamp with time zone,
	"lock_reason" "user_lock_reason",
	"deletion_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_lock_consistency" CHECK (("users"."locked_at" IS NULL) = ("users"."lock_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"purpose" "verification_purpose" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"type" "wallet_type" NOT NULL,
	"balance_nano_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_user_type_unique" UNIQUE("user_id","type")
);
--> statement-breakpoint
ALTER TABLE "allowance_spending" ADD CONSTRAINT "allowance_spending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_model_catalog_id_model_catalog_id_fk" FOREIGN KEY ("model_catalog_id") REFERENCES "public"."model_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_forks" ADD CONSTRAINT "conversation_forks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_forks" ADD CONSTRAINT "conversation_forks_tip_message_id_messages_id_fk" FOREIGN KEY ("tip_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_link_id_shared_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."shared_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_spending" ADD CONSTRAINT "conversation_spending_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_instructions" ADD CONSTRAINT "custom_instructions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_members" ADD CONSTRAINT "epoch_members_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epochs" ADD CONSTRAINT "epochs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epochs" ADD CONSTRAINT "epochs_previous_epoch_id_epochs_id_fk" FOREIGN KEY ("previous_epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_usage_record_id_usage_records_id_fk" FOREIGN KEY ("usage_record_id") REFERENCES "public"."usage_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_completions" ADD CONSTRAINT "llm_completions_usage_record_id_usage_records_id_fk" FOREIGN KEY ("usage_record_id") REFERENCES "public"."usage_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_usage_record_id_usage_records_id_fk" FOREIGN KEY ("usage_record_id") REFERENCES "public"."usage_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_budgets" ADD CONSTRAINT "member_budgets_member_id_conversation_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."conversation_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_id_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_epoch_fk" FOREIGN KEY ("conversation_id","epoch_number") REFERENCES "public"."epochs"("conversation_id","epoch_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_model_catalog_id_model_catalog_id_fk" FOREIGN KEY ("model_catalog_id") REFERENCES "public"."model_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_links" ADD CONSTRAINT "shared_links_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_messages" ADD CONSTRAINT "shared_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_messages" ADD CONSTRAINT "shared_messages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_model_catalog_id_model_catalog_id_fk" FOREIGN KEY ("model_catalog_id") REFERENCES "public"."model_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_items_message_id_position_idx" ON "content_items" USING btree ("message_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "content_items_storage_key_unique" ON "content_items" USING btree ("storage_key") WHERE "content_items"."storage_key" is not null;--> statement-breakpoint
CREATE INDEX "content_items_model_catalog_id_idx" ON "content_items" USING btree ("model_catalog_id") WHERE "content_items"."model_catalog_id" is not null;--> statement-breakpoint
CREATE INDEX "conversation_forks_tip_message_id_idx" ON "conversation_forks" USING btree ("tip_message_id") WHERE "conversation_forks"."tip_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_user_active" ON "conversation_members" USING btree ("conversation_id","user_id") WHERE "conversation_members"."left_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_link_active" ON "conversation_members" USING btree ("conversation_id","link_id") WHERE "conversation_members"."left_at" is null;--> statement-breakpoint
CREATE INDEX "conversation_members_conversation_id_idx" ON "conversation_members" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_members_user_id_idx" ON "conversation_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversation_members_link_id_idx" ON "conversation_members" USING btree ("link_id") WHERE "conversation_members"."link_id" is not null;--> statement-breakpoint
CREATE INDEX "conversation_members_invited_by_user_id_idx" ON "conversation_members" USING btree ("invited_by_user_id") WHERE "conversation_members"."invited_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "conversations_user_id_idx" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "epoch_members_public_key_idx" ON "epoch_members" USING btree ("member_public_key");--> statement-breakpoint
CREATE INDEX "epochs_previous_epoch_id_idx" ON "epochs" USING btree ("previous_epoch_id") WHERE "epochs"."previous_epoch_id" is not null;--> statement-breakpoint
CREATE INDEX "idempotency_keys_purge_idx" ON "idempotency_keys" USING btree ("completed_at") WHERE "idempotency_keys"."completed_at" is not null;--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("shard","priority","next_attempt_at") WHERE "jobs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key_unique" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "jobs_prune_idx" ON "jobs" USING btree ("finished_at") WHERE "jobs"."status" = 'succeeded';--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_wallet_created_idx" ON "ledger_entries" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_payment_id_idx" ON "ledger_entries" USING btree ("payment_id") WHERE "ledger_entries"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_entries_usage_record_id_idx" ON "ledger_entries" USING btree ("usage_record_id") WHERE "ledger_entries"."usage_record_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation_epoch_idx" ON "messages" USING btree ("conversation_id","epoch_number");--> statement-breakpoint
CREATE INDEX "messages_parent_message_id_idx" ON "messages" USING btree ("parent_message_id") WHERE "messages"."parent_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_sender_id_idx" ON "messages" USING btree ("sender_id") WHERE "messages"."sender_id" is not null;--> statement-breakpoint
CREATE INDEX "model_pricing_model_catalog_id_idx" ON "model_pricing" USING btree ("model_catalog_id");--> statement-breakpoint
CREATE INDEX "payments_user_id_idx" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "shared_links_conversation_id_idx" ON "shared_links" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "shared_messages_message_id_idx" ON "shared_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "shared_messages_created_by_idx" ON "shared_messages" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "usage_records_user_id_idx" ON "usage_records" USING btree ("user_id") WHERE "usage_records"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "usage_records_content_item_id_idx" ON "usage_records" USING btree ("content_item_id") WHERE "usage_records"."content_item_id" is not null;--> statement-breakpoint
CREATE INDEX "usage_records_model_catalog_id_idx" ON "usage_records" USING btree ("model_catalog_id");--> statement-breakpoint
CREATE INDEX "usage_records_run_id_idx" ON "usage_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "verification_tokens_user_id_idx" ON "verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wallets_user_id_idx" ON "wallets" USING btree ("user_id");