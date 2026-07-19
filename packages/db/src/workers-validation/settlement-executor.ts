import { sql } from 'drizzle-orm';

import type { Database } from '../client';

/**
 * Plain executor for the settlement platform validation (the thin-shell DO
 * pattern: the Durable Object class holds only platform glue and delegates
 * here). This module must stay free of platform imports so the identical logic
 * runs under node-environment vitest (where coverage applies) and under workerd
 * via the pool-workers project.
 *
 * It drives the real settlement transaction shape — `db.transaction(...)`, the
 * exact wrapper `runSettlement` mints a `SettlementTx` inside — writing real
 * `ledger_entries` legs so the production DEFERRABLE INITIALLY DEFERRED
 * zero-sum trigger (migration `0039_ledger-zero-sum-trigger`) is the arbiter.
 * `runSettlement`/`chargeWithinTx` themselves live in `apps/api` and cannot be
 * imported here (packages/db must not depend on the product Worker); this is the
 * faithful multi-leg-insert alternative the audit card permits, exercising the
 * identical durable path: interactive transaction + real trigger under workerd.
 *
 * House-account legs (no wallet FK, no balance column) keep the fixture free of
 * user/wallet seeding while still being genuine double-entry rows the trigger
 * sums.
 */

export interface SettlementValidationResult {
  /** A settlement whose ledger legs do not sum to zero. */
  unbalanced: {
    /** The transaction aborted at COMMIT (the deferred trigger fired). */
    aborted: boolean;
    /** The abort came from the zero-sum trigger (its message names the sum). */
    triggerRejected: boolean;
    /** Content saved in the same transaction (must be false — saved⟺billed). */
    contentPersisted: boolean;
    /** Ledger legs that survived the abort (must be 0). */
    legsPersisted: number;
  };
  /** A settlement whose ledger legs sum to zero. */
  balanced: {
    /** The transaction committed. */
    committed: boolean;
    /** Content saved in the same transaction (must be true — saved⟺billed). */
    contentPersisted: boolean;
    /** Ledger legs that committed (must be 2). */
    legsPersisted: number;
  };
  /** The same settlement body run twice (simulated retry after a crash). */
  exactlyOnce: {
    /** Legs the first attempt inserted (must be 2). */
    firstAttemptLegsInserted: number;
    /** Legs the retry inserted (must be 0 — the idempotency key no-ops it). */
    secondAttemptLegsInserted: number;
    /** Ledger legs present after both attempts (must be 2 — exactly once). */
    finalLegCount: number;
  };
}

/**
 * The zero-sum trigger raises at COMMIT (it is DEFERRABLE INITIALLY DEFERRED),
 * so the driver's top-level message is only "Failed query: commit"; the trigger
 * text ("legs sum to N (must be 0)") rides the cause chain. Walking the chain is
 * what distinguishes the trigger abort from any other commit-time failure.
 */
function isZeroSumTriggerError(error: unknown): boolean {
  let current: unknown = error;
  while (current !== null && typeof current === 'object') {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && /legs sum to/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A single house-account ledger leg for the fixture. */
interface Leg {
  house: 'revenue' | 'payments-in' | 'promo';
  amount: number;
  key: string;
}

/**
 * The subset both a `Database` and a transaction handle expose. Legs are
 * inserted from inside `db.transaction(...)`, where the callback receives a
 * transaction (no `$client`), so the helper types against `execute` alone.
 */
type Executor = Pick<Database, 'execute'>;

/**
 * Inserts one settlement's legs, no-oping any whose idempotency key already
 * exists (the ledger's per-leg unique key is the exactly-once fence). Returns
 * the number of rows actually inserted.
 */
async function insertLegs(
  tx: Executor,
  transactionId: string,
  legs: readonly Leg[]
): Promise<number> {
  let inserted = 0;
  for (const leg of legs) {
    const result = await tx.execute(
      sql`insert into ledger_entries
            (transaction_id, house_account, kind, amount_nano_usd, idempotency_key)
          values (${transactionId}, ${leg.house}, 'charge', ${leg.amount}, ${leg.key})
          on conflict (idempotency_key) do nothing
          returning id`
    );
    inserted += result.rows.length;
  }
  return inserted;
}

/** Narrows the `unknown` cell of a `count(*)::int` query to a number. */
export function requireCount(value: unknown): number {
  if (typeof value !== 'number') {
    throw new TypeError('requireCount: expected a numeric count');
  }
  return value;
}

async function countLegs(db: Database, transactionId: string): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as n from ledger_entries where transaction_id = ${transactionId}`
  );
  return requireCount(result.rows[0]?.['n']);
}

/**
 * Drives the real settlement transaction shape inside whatever runtime calls it,
 * asserting the three money invariants via a structured result the caller
 * checks. `scratchTable` is a per-run content table (created and dropped here);
 * distinct names let the node and workers projects run concurrently without
 * colliding, exactly like the lock-validation executor.
 */
export async function runSettlementValidation(
  db: Database,
  scratchTable: string
): Promise<SettlementValidationResult> {
  if (!/^[a-z][a-z0-9_]*$/.test(scratchTable)) {
    throw new Error('runSettlementValidation: scratchTable must be a simple lowercase identifier');
  }
  const content = sql.raw(scratchTable);

  const runId = crypto.randomUUID();
  const unbalancedTxn = crypto.randomUUID();
  const balancedTxn = crypto.randomUUID();
  const exactlyOnceTxn = crypto.randomUUID();

  await db.execute(
    sql`create table if not exists ${content} (id uuid primary key default uuidv7(), transaction_id uuid not null, marker text not null)`
  );

  try {
    // --- Unbalanced: the deferred zero-sum trigger must abort at COMMIT, taking
    //     the content write down with it (saved⟺billed). ---
    let unbalancedAborted = false;
    let triggerRejected = false;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`insert into ${content} (transaction_id, marker) values (${unbalancedTxn}, 'saved')`
        );
        await insertLegs(tx, unbalancedTxn, [
          { house: 'revenue', amount: 100, key: `${runId}:unbalanced:a` },
          { house: 'payments-in', amount: -40, key: `${runId}:unbalanced:b` },
        ]);
      });
    } catch (error) {
      unbalancedAborted = true;
      triggerRejected = isZeroSumTriggerError(error);
    }
    const unbalancedContent = await db.execute(
      sql`select 1 from ${content} where transaction_id = ${unbalancedTxn}`
    );
    const unbalancedLegs = await countLegs(db, unbalancedTxn);

    // --- Balanced: legs sum to zero, so content and charge commit together. ---
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`insert into ${content} (transaction_id, marker) values (${balancedTxn}, 'saved')`
      );
      await insertLegs(tx, balancedTxn, [
        { house: 'revenue', amount: 100, key: `${runId}:balanced:a` },
        { house: 'payments-in', amount: -100, key: `${runId}:balanced:b` },
      ]);
    });
    const balancedContent = await db.execute(
      sql`select 1 from ${content} where transaction_id = ${balancedTxn}`
    );
    const balancedLegs = await countLegs(db, balancedTxn);

    // --- Exactly-once: the identical settlement body, run twice to simulate a
    //     retry after a crash swallowed the first attempt's ack. ---
    const exactlyOnceLegs: readonly Leg[] = [
      { house: 'revenue', amount: 100, key: `${runId}:once:a` },
      { house: 'payments-in', amount: -100, key: `${runId}:once:b` },
    ];
    const firstAttemptLegsInserted = await db.transaction((tx) =>
      insertLegs(tx, exactlyOnceTxn, exactlyOnceLegs)
    );
    const secondAttemptLegsInserted = await db.transaction((tx) =>
      insertLegs(tx, exactlyOnceTxn, exactlyOnceLegs)
    );
    const finalLegCount = await countLegs(db, exactlyOnceTxn);

    return {
      unbalanced: {
        aborted: unbalancedAborted,
        triggerRejected,
        contentPersisted: unbalancedContent.rows.length > 0,
        legsPersisted: unbalancedLegs,
      },
      balanced: {
        committed: true,
        contentPersisted: balancedContent.rows.length > 0,
        legsPersisted: balancedLegs,
      },
      exactlyOnce: {
        firstAttemptLegsInserted,
        secondAttemptLegsInserted,
        finalLegCount,
      },
    };
  } finally {
    // Deleting a whole balanced group re-fires the trigger on the old group,
    // which is empty (sum 0) once every leg is gone — a legal delete.
    await db.execute(
      sql`delete from ledger_entries where transaction_id in (${balancedTxn}, ${exactlyOnceTxn})`
    );
    await db.execute(sql`drop table if exists ${content}`);
  }
}
