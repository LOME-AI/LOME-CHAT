import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { pruneSucceededJobs } from './prune.js';
import type { DbTransaction } from '../idempotency/transaction.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
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

async function insertFinishedJob(
  tx: DbTransaction,
  status: 'succeeded' | 'dead' | 'cancelled',
  finishedDaysAgo: number
): Promise<string> {
  const rows = await tx
    .insert(jobs)
    .values({
      type: 'test.prune.v1',
      payload: {},
      status,
      maxClaims: 8,
      maxFailures: 5,
      leaseSeconds: 60,
      finishedAt: sql`now() - make_interval(days => ${finishedDaysAgo})`,
    })
    .returning({ id: jobs.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert finished job');
  return row.id;
}

async function exists(tx: DbTransaction, jobId: string): Promise<boolean> {
  const rows = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId));
  return rows.length === 1;
}

afterAll(async () => {
  await db.$client.end();
});

describe('pruneSucceededJobs', () => {
  it('deletes succeeded rows older than the seven-day retention', async () => {
    const { pruned, kept } = await withRollback(async (tx) => {
      const oldId = await insertFinishedJob(tx, 'succeeded', 8);
      const count = await pruneSucceededJobs(tx, { batchSize: 100 });
      return { pruned: count, kept: await exists(tx, oldId) };
    });
    expect(pruned).toBe(1);
    expect(kept).toBe(false);
  });

  it('keeps succeeded rows inside the retention window', async () => {
    const kept = await withRollback(async (tx) => {
      const recentId = await insertFinishedJob(tx, 'succeeded', 6);
      await pruneSucceededJobs(tx, { batchSize: 100 });
      return exists(tx, recentId);
    });
    expect(kept).toBe(true);
  });

  it('never touches dead or cancelled rows — they live forever', async () => {
    const { deadKept, cancelledKept } = await withRollback(async (tx) => {
      const deadId = await insertFinishedJob(tx, 'dead', 400);
      const cancelledId = await insertFinishedJob(tx, 'cancelled', 400);
      await pruneSucceededJobs(tx, { batchSize: 100 });
      return { deadKept: await exists(tx, deadId), cancelledKept: await exists(tx, cancelledId) };
    });
    expect(deadKept).toBe(true);
    expect(cancelledKept).toBe(true);
  });

  it('deletes at most the batch size per call', async () => {
    const counts = await withRollback(async (tx) => {
      await insertFinishedJob(tx, 'succeeded', 9);
      await insertFinishedJob(tx, 'succeeded', 10);
      await insertFinishedJob(tx, 'succeeded', 11);
      const first = await pruneSucceededJobs(tx, { batchSize: 2 });
      const second = await pruneSucceededJobs(tx, { batchSize: 2 });
      return { first, second };
    });
    expect(counts.first).toBe(2);
    expect(counts.second).toBe(1);
  });
});
