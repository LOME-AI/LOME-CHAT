import { LOCAL_NEON_DEV_CONFIG, accountDeletionEvents, createDb } from '@hushbox/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DELETION_EVENT_RETENTION_DAYS,
  purgeExpiredAccountDeletionEvents,
} from './deletion-events-purge.js';
import type { DbTransaction } from '../lib/idempotency/transaction.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for deletion-events purge integration tests');
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

async function insertEvent(tx: DbTransaction, deletedDaysAgo: number): Promise<string> {
  const rows = await tx
    .insert(accountDeletionEvents)
    .values({ deletedAt: sql`now() - make_interval(days => ${deletedDaysAgo})` })
    .returning({ id: accountDeletionEvents.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert deletion event');
  return row.id;
}

async function exists(tx: DbTransaction, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: accountDeletionEvents.id })
    .from(accountDeletionEvents)
    .where(eq(accountDeletionEvents.id, id));
  return rows.length === 1;
}

afterAll(async () => {
  await db.$client.end();
});

describe('purgeExpiredAccountDeletionEvents', () => {
  it('deletes events older than the ninety-day retention window', async () => {
    const kept = await withRollback(async (tx) => {
      const oldId = await insertEvent(tx, DELETION_EVENT_RETENTION_DAYS + 1);
      await purgeExpiredAccountDeletionEvents(tx, { batchSize: 1000 });
      return exists(tx, oldId);
    });
    expect(kept).toBe(false);
  });

  it('keeps events inside the retention window', async () => {
    const kept = await withRollback(async (tx) => {
      const recentId = await insertEvent(tx, DELETION_EVENT_RETENTION_DAYS - 1);
      await purgeExpiredAccountDeletionEvents(tx, { batchSize: 1000 });
      return exists(tx, recentId);
    });
    expect(kept).toBe(true);
  });

  it('deletes at most the batch size per call', async () => {
    const counts = await withRollback(async (tx) => {
      await insertEvent(tx, DELETION_EVENT_RETENTION_DAYS + 2);
      await insertEvent(tx, DELETION_EVENT_RETENTION_DAYS + 3);
      await insertEvent(tx, DELETION_EVENT_RETENTION_DAYS + 4);
      const first = await purgeExpiredAccountDeletionEvents(tx, { batchSize: 2 });
      const second = await purgeExpiredAccountDeletionEvents(tx, { batchSize: 2 });
      return { first, second };
    });
    expect(counts.first).toBe(2);
    expect(counts.second).toBeGreaterThanOrEqual(1);
  });
});
