-- Golden dump of hand-written Postgres functions and triggers (audit F-09).
-- Drizzle-kit does not model these objects, so the migration-drift gate cannot
-- see them; this file is the drift guard. Regenerate intentionally with:
--   pnpm verify:db-objects:update
-- Do not edit by hand.

-- function: admin_audit_block_mutation
CREATE OR REPLACE FUNCTION public.admin_audit_block_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'admin_audit is append-only: % refused', TG_OP;
END;
$function$

-- function: assert_ledger_transaction_balanced
CREATE OR REPLACE FUNCTION public.assert_ledger_transaction_balanced()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  total bigint;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT coalesce(sum(amount_nano_usd), 0) INTO total
    FROM ledger_entries
    WHERE transaction_id = NEW.transaction_id;
    IF total <> 0 THEN
      RAISE EXCEPTION 'ledger transaction % legs sum to % (must be 0)',
        NEW.transaction_id, total;
    END IF;
  END IF;
  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE' AND NEW.transaction_id <> OLD.transaction_id) THEN
    SELECT coalesce(sum(amount_nano_usd), 0) INTO total
    FROM ledger_entries
    WHERE transaction_id = OLD.transaction_id;
    IF total <> 0 THEN
      RAISE EXCEPTION 'ledger transaction % legs sum to % (must be 0)',
        OLD.transaction_id, total;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$

-- function: validate_sender_id
CREATE OR REPLACE FUNCTION public.validate_sender_id()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.sender_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM users WHERE id = NEW.sender_id)
     OR EXISTS (SELECT 1 FROM shared_links WHERE id = NEW.sender_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'sender_id % does not exist in users or shared_links', NEW.sender_id;
END;
$function$

-- trigger: admin_audit.admin_audit_append_only
CREATE TRIGGER admin_audit_append_only BEFORE DELETE OR UPDATE ON public.admin_audit FOR EACH ROW EXECUTE FUNCTION admin_audit_block_mutation()

-- trigger: admin_audit.admin_audit_block_truncate
CREATE TRIGGER admin_audit_block_truncate BEFORE TRUNCATE ON public.admin_audit FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_block_mutation()

-- trigger: ledger_entries.ledger_entries_zero_sum
CREATE CONSTRAINT TRIGGER ledger_entries_zero_sum AFTER INSERT OR DELETE OR UPDATE OF transaction_id, amount_nano_usd, wallet_id, house_account ON public.ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced()
