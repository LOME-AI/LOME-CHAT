-- Per-transaction zero-sum enforced at write time. A CHECK cannot span rows,
-- so the strongest PG-native mechanism is a DEFERRABLE INITIALLY DEFERRED
-- constraint trigger: it runs at COMMIT, after every leg of the settlement
-- transaction is in place, and aborts the whole transaction when a
-- transaction_id's signed legs do not sum to zero. Drizzle-kit does not model
-- triggers, so this lives in a hand-written migration.
--
-- Coverage is INSERT, DELETE, and UPDATE OF the sum-bearing columns. An
-- UPDATE that moves a leg to another transaction_id re-checks both the old
-- and the new group; a DELETE re-checks the old group (a group whose legs are
-- all gone sums to zero by definition). The UPDATE list is column-scoped
-- because hard deletion of payments / usage_records rows cascades
-- ON DELETE SET NULL onto ledger_entries.payment_id / usage_record_id —
-- legitimate pseudonymization updates that must not re-fire the trigger.
-- search_path is pinned so the unqualified ledger_entries reference can never
-- resolve through a caller-controlled schema.
CREATE FUNCTION assert_ledger_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
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
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_zero_sum
AFTER INSERT OR DELETE OR UPDATE OF transaction_id, amount_nano_usd, wallet_id, house_account
ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION assert_ledger_transaction_balanced();
