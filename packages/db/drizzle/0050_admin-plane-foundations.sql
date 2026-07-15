ALTER TABLE "admin_audit" ADD COLUMN "undoes" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "discarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "admin_disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_undoes_admin_audit_id_fk" FOREIGN KEY ("undoes") REFERENCES "public"."admin_audit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_target_idx" ON "admin_audit" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "admin_audit_actor_created_at_idx" ON "admin_audit" USING btree ("actor","created_at");--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_undoes_unique" UNIQUE("undoes");--> statement-breakpoint
-- Append-only hardening for admin_audit. Drizzle-kit does not model
-- triggers, so this lives as hand-written SQL in the generated migration.
-- The triggers defend against every role except the table owner and
-- superusers (either can DROP/DISABLE them or flip
-- session_replication_role); the Kopia→B2 backup is the off-vendor copy
-- that survives even owner-level tampering.
CREATE FUNCTION admin_audit_block_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit is append-only: % refused', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER admin_audit_append_only
BEFORE UPDATE OR DELETE ON admin_audit
FOR EACH ROW EXECUTE FUNCTION admin_audit_block_mutation();--> statement-breakpoint
-- TRUNCATE never fires row-level triggers; block it at statement level.
CREATE TRIGGER admin_audit_block_truncate
BEFORE TRUNCATE ON admin_audit
FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_block_mutation();--> statement-breakpoint
-- The admin SQL panel's SELECT-only Postgres role, created in-chain so
-- local provisioning carries the identical role and write-proofness is
-- testable, never merely asserted. NOLOGIN here: the production login
-- password is minted out-of-band (founder-physical), never in a migration.
-- Roles are cluster-level, so creation is guarded for re-runs after
-- db:reset; grants are idempotent by nature.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_sql_panel') THEN
    CREATE ROLE admin_sql_panel NOLOGIN;
  END IF;
END;
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO admin_sql_panel;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO admin_sql_panel;--> statement-breakpoint
-- Future tables created by the migration role stay readable by the panel.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO admin_sql_panel;--> statement-breakpoint
-- Carve-outs: plaintext credential material is never panel-readable.
-- verification_tokens stores plaintext bearer tokens; users.opaque_registration
-- is the OPAQUE server record (offline-dictionary-attack material). Columns
-- encrypted under an app-held key (e.g. totp_secret_encrypted) stay readable.
REVOKE SELECT ON verification_tokens FROM admin_sql_panel;--> statement-breakpoint
REVOKE SELECT ON users FROM admin_sql_panel;--> statement-breakpoint
GRANT SELECT (
  id, email, username, email_verified, totp_secret_encrypted, totp_enabled,
  has_acknowledged_phrase, public_key, password_wrapped_private_key,
  recovery_wrapped_private_key, locked_at, lock_reason, deletion_requested_at,
  created_at, updated_at
) ON users TO admin_sql_panel;
