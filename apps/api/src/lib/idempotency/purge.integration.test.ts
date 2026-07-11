import { LOCAL_NEON_DEV_CONFIG, createDb, idempotencyKeys } from '@hushbox/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { purgeTerminalIdempotencyKeys } from './purge.js';
import type { DbTransaction } from './transaction.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for idempotency integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

class Rollback extends Error {}

async function withRollback<T>(function_: (tx: DbTransaction) => Promise<T>): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      captured = { value: await function_(tx) };
      throw new Rollback('roll back test writes');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  if (captured === undefined) throw new Error('withRollback: body did not complete');
  return captured.value;
}

interface KeyRowSeed {
  readonly status: 'claimed' | 'succeeded' | 'failed';
  /** Null models a non-terminal row; a number is days before now. */
  readonly completedDaysAgo: number | null;
}

async function insertKeyRow(tx: DbTransaction, seed: KeyRowSeed): Promise<string> {
  const rows = await tx
    .insert(idempotencyKeys)
    .values({
      userId: crypto.randomUUID(),
      route: '/test/purge',
      key: crypto.randomUUID(),
      kind: 'request',
      status: seed.status,
      bodyHash: 'hash',
      claimedBy: 'purge-test',
      completedAt:
        seed.completedDaysAgo === null
          ? null
          : sql`now() - make_interval(days => ${seed.completedDaysAgo})`,
    })
    .returning({ id: idempotencyKeys.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert idempotency key row');
  return row.id;
}

async function exists(tx: DbTransaction, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.id, id));
  return rows.length === 1;
}

afterAll(async () => {
  await db.$client.end();
});

describe('purgeTerminalIdempotencyKeys', () => {
  it('deletes terminal rows older than the purge TTL', async () => {
    const kept = await withRollback(async (tx) => {
      const oldSucceeded = await insertKeyRow(tx, { status: 'succeeded', completedDaysAgo: 8 });
      const oldFailed = await insertKeyRow(tx, { status: 'failed', completedDaysAgo: 8 });
      await purgeTerminalIdempotencyKeys(tx, { batchSize: 100 });
      return { succeeded: await exists(tx, oldSucceeded), failed: await exists(tx, oldFailed) };
    });
    expect(kept).toEqual({ succeeded: false, failed: false });
  });

  it('keeps terminal rows inside the purge TTL', async () => {
    const kept = await withRollback(async (tx) => {
      const recent = await insertKeyRow(tx, { status: 'succeeded', completedDaysAgo: 6 });
      await purgeTerminalIdempotencyKeys(tx, { batchSize: 100 });
      return exists(tx, recent);
    });
    expect(kept).toBe(true);
  });

  it('never touches non-terminal rows, however old', async () => {
    const kept = await withRollback(async (tx) => {
      const claimed = await insertKeyRow(tx, { status: 'claimed', completedDaysAgo: null });
      // Age the claim far past the TTL; completedAt stays null (non-terminal).
      await tx
        .update(idempotencyKeys)
        .set({ createdAt: sql`now() - make_interval(days => 400)` })
        .where(eq(idempotencyKeys.id, claimed));
      await purgeTerminalIdempotencyKeys(tx, { batchSize: 100 });
      return exists(tx, claimed);
    });
    expect(kept).toBe(true);
  });

  it('deletes at most the batch size per call', async () => {
    const counts = await withRollback(async (tx) => {
      await insertKeyRow(tx, { status: 'succeeded', completedDaysAgo: 9 });
      await insertKeyRow(tx, { status: 'failed', completedDaysAgo: 10 });
      await insertKeyRow(tx, { status: 'succeeded', completedDaysAgo: 11 });
      const first = await purgeTerminalIdempotencyKeys(tx, { batchSize: 2 });
      const second = await purgeTerminalIdempotencyKeys(tx, { batchSize: 2 });
      return { first, second };
    });
    expect(counts.first).toBe(2);
    expect(counts.second).toBe(1);
  });
});
