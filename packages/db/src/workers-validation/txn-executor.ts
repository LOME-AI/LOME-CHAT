import { sql } from 'drizzle-orm';

import type { Database } from '../client';

/**
 * Plain executor for the DO-finalize platform validation (the thin-shell DO
 * pattern: the Durable Object class holds only platform glue and delegates
 * here). This module must stay free of platform imports so the identical
 * logic runs under node-environment vitest (where coverage applies) and under
 * workerd via the pool-workers project.
 */

export interface LockValidationResult {
  /** Value read back inside the open transaction right after its own insert. */
  readYourWrites: string;
  /** Whether a concurrent client could see the uncommitted insert (must be false). */
  uncommittedVisibleToOthers: boolean;
  /** Postgres error code a concurrent FOR UPDATE NOWAIT claimant hit ('55P03' = lock held). */
  lockBlockedCode: string;
  /** Value a concurrent client reads after commit (proves the txn committed atomically). */
  postCommitValue: string;
  /** Whether the concurrent client could lock the row once the transaction committed. */
  relockedAfterCommit: boolean;
}

/** Walks the cause chain for a Postgres error code (drizzle wraps driver errors). */
export function pgErrorCode(error: unknown): string {
  let current: unknown = error;
  while (current !== null && typeof current === 'object') {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return 'unknown';
}

export function requireString(row: Record<string, unknown> | undefined, column: string): string {
  const value = row?.[column];
  if (typeof value !== 'string') {
    throw new TypeError(`runLockValidation: expected string column '${column}' in result row`);
  }
  return value;
}

/**
 * Runs the settlement-shaped transaction the architecture rests on:
 * a multi-statement interactive transaction (insert, read-your-writes,
 * update, SELECT ... FOR UPDATE) on one claimant while a second claimant
 * proves the row lock is real via FOR UPDATE NOWAIT.
 *
 * The scratch table is created and dropped per run; callers pass distinct
 * table names so concurrent runs (node project vs workers project) cannot
 * collide.
 */
export async function runLockValidation(
  claimantA: Database,
  claimantB: Database,
  tableName: string
): Promise<LockValidationResult> {
  if (!/^[a-z][a-z0-9_]*$/.test(tableName)) {
    throw new Error('runLockValidation: tableName must be a simple lowercase identifier');
  }
  const table = sql.raw(tableName);

  await claimantA.execute(
    sql`create table if not exists ${table} (id uuid primary key default uuidv7(), value text not null)`
  );
  try {
    const seeded = await claimantA.execute(
      sql`insert into ${table} (value) values ('seeded') returning id`
    );
    const seedId = requireString(seeded.rows[0], 'id');

    let readYourWrites = '';
    let uncommittedVisibleToOthers = true;
    let lockBlockedCode = 'none';

    await claimantA.transaction(async (tx) => {
      const inserted = await tx.execute(
        sql`insert into ${table} (value) values ('inside-txn') returning id`
      );
      const insideId = requireString(inserted.rows[0], 'id');

      const readBack = await tx.execute(sql`select value from ${table} where id = ${insideId}`);
      readYourWrites = requireString(readBack.rows[0], 'value');

      const concurrentRead = await claimantB.execute(
        sql`select id from ${table} where id = ${insideId}`
      );
      uncommittedVisibleToOthers = concurrentRead.rows.length > 0;

      await tx.execute(sql`update ${table} set value = 'updated-in-txn' where id = ${seedId}`);
      await tx.execute(sql`select id from ${table} where id = ${seedId} for update`);

      try {
        // NOWAIT is load-bearing: without it, claimant B would block on A's
        // row lock while A's transaction awaits B inline — the validation
        // would self-deadlock. NOWAIT surfaces the held lock as an immediate
        // 55P03 instead.
        await claimantB.transaction(async (txB) => {
          await txB.execute(sql`select id from ${table} where id = ${seedId} for update nowait`);
        });
      } catch (error) {
        lockBlockedCode = pgErrorCode(error);
      }
    });

    const postCommit = await claimantB.execute(
      sql`select value from ${table} where id = ${seedId}`
    );
    const postCommitValue = requireString(postCommit.rows[0], 'value');

    let relockedAfterCommit = false;
    await claimantB.transaction(async (txB) => {
      const relocked = await txB.execute(
        sql`select id from ${table} where id = ${seedId} for update nowait`
      );
      relockedAfterCommit = relocked.rows.length === 1;
    });

    return {
      readYourWrites,
      uncommittedVisibleToOthers,
      lockBlockedCode,
      postCommitValue,
      relockedAfterCommit,
    };
  } finally {
    await claimantA.execute(sql`drop table if exists ${table}`);
  }
}
