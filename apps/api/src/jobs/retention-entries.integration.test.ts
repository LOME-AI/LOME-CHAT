import {
  LOCAL_NEON_DEV_CONFIG,
  accountDeletionEvents,
  createDb,
  idempotencyKeys,
  jobs,
} from '@hushbox/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
  createRetentionEntry,
  createRetentionSteps,
  drainRetentionBatches,
} from './retention-entries.js';
import type { DbTransaction } from '../lib/idempotency/transaction.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for retention entry integration tests');
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

afterAll(async () => {
  await db.$client.end();
});

describe('drainRetentionBatches', () => {
  it('drains until a batch comes back short', async () => {
    const batches: number[] = [];
    const total = await drainRetentionBatches((batchSize) => {
      batches.push(batchSize);
      return Promise.resolve(batches.length < 3 ? batchSize : 1);
    }, 10);
    expect(batches).toEqual([10, 10, 10]);
    expect(total).toBe(21);
  });

  it('caps the number of batches per pass', async () => {
    let calls = 0;
    const total = await drainRetentionBatches((batchSize) => {
      calls += 1;
      return Promise.resolve(batchSize);
    }, 10);
    expect(calls).toBe(RETENTION_MAX_BATCHES);
    expect(total).toBe(10 * RETENTION_MAX_BATCHES);
  });
});

describe('createRetentionEntry', () => {
  it('drains the step with the retention batch size', async () => {
    const batches: number[] = [];
    const entry = createRetentionEntry('idempotency-key-purge', (batchSize) => {
      batches.push(batchSize);
      return Promise.resolve(0);
    });
    expect(entry.name).toBe('idempotency-key-purge');
    await entry.run();
    expect(batches).toEqual([RETENTION_BATCH_SIZE]);
  });
});

describe('createRetentionSteps', () => {
  it('purges an expired terminal idempotency key through the bound step', async () => {
    const gone = await withRollback(async (tx) => {
      const rows = await tx
        .insert(idempotencyKeys)
        .values({
          userId: crypto.randomUUID(),
          route: '/test/retention',
          key: crypto.randomUUID(),
          kind: 'request',
          status: 'succeeded',
          bodyHash: 'hash',
          claimedBy: 'retention-test',
          completedAt: sql`now() - make_interval(days => 9)`,
        })
        .returning({ id: idempotencyKeys.id });
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('failed to insert key row');
      const steps = createRetentionSteps(tx);
      const purged = await steps.purgeIdempotencyKeys(1000);
      const remaining = await tx
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.id, id));
      return { purged, stillThere: remaining.length === 1 };
    });
    expect(gone.purged).toBeGreaterThanOrEqual(1);
    expect(gone.stillThere).toBe(false);
  });

  it('purges an expired deletion event through the bound step', async () => {
    const purged = await withRollback(async (tx) => {
      await tx
        .insert(accountDeletionEvents)
        .values({ deletedAt: sql`now() - make_interval(days => 91)` });
      const steps = createRetentionSteps(tx);
      return steps.purgeDeletionEvents(1000);
    });
    expect(purged).toBeGreaterThanOrEqual(1);
  });

  it('prunes an old discarded job through the bound step', async () => {
    const gone = await withRollback(async (tx) => {
      const rows = await tx
        .insert(jobs)
        .values({
          type: 'test.retention.v1',
          shard: 'bulk',
          payload: {},
          status: 'dead',
          maxClaims: 8,
          maxFailures: 5,
          leaseSeconds: 60,
          finishedAt: sql`now() - make_interval(days => 40)`,
          discardedAt: sql`now() - make_interval(days => 31)`,
        })
        .returning({ id: jobs.id });
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('failed to insert job row');
      const steps = createRetentionSteps(tx);
      const pruned = await steps.pruneDiscardedJobs(1000);
      const remaining = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id));
      return { pruned, stillThere: remaining.length === 1 };
    });
    expect(gone.pruned).toBeGreaterThanOrEqual(1);
    expect(gone.stillThere).toBe(false);
  });

  it('prunes an old succeeded job through the bound step', async () => {
    const gone = await withRollback(async (tx) => {
      const rows = await tx
        .insert(jobs)
        .values({
          type: 'test.retention.v1',
          shard: 'bulk',
          payload: {},
          status: 'succeeded',
          maxClaims: 8,
          maxFailures: 5,
          leaseSeconds: 60,
          finishedAt: sql`now() - make_interval(days => 9)`,
        })
        .returning({ id: jobs.id });
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('failed to insert job row');
      const steps = createRetentionSteps(tx);
      const pruned = await steps.pruneSucceededJobs(1000);
      const remaining = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id));
      return { pruned, stillThere: remaining.length === 1 };
    });
    expect(gone.pruned).toBeGreaterThanOrEqual(1);
    expect(gone.stillThere).toBe(false);
  });
});
