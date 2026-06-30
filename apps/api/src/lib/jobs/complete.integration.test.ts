import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { claimBatch } from './claim.js';
import { completeDead, completeFail, completeOk, completeYield, heartbeatJob } from './complete.js';
import type { DbTransaction } from '../idempotency/transaction.js';
import type { JobFence } from './complete.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * Every test runs inside a rolled-back transaction: the jobs table is a
 * single shared queue, so a committed running row here would skew the
 * dispatcher-pass tests' shard-wide re-arm queries running in parallel.
 */
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

interface RunningJobOptions {
  readonly cancelRequested?: boolean;
  readonly shard?: 'default' | 'bulk';
}

async function insertRunningJob(
  tx: DbTransaction,
  options: RunningJobOptions = {}
): Promise<{ jobId: string; fence: JobFence }> {
  const rows = await tx
    .insert(jobs)
    .values({
      type: 'test.complete.v1',
      payload: { step: 1 },
      shard: options.shard ?? 'default',
      status: 'running',
      claims: 1,
      maxClaims: 8,
      maxFailures: 5,
      leaseSeconds: 60,
      claimedAt: sql`now()`,
      claimedBy: 'claimant-a',
      cancelRequested: options.cancelRequested === true,
    })
    .returning({ id: jobs.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert running job');
  return { jobId: row.id, fence: { jobId: row.id, claimedBy: 'claimant-a', claims: 1 } };
}

async function readJob(tx: DbTransaction, jobId: string): Promise<typeof jobs.$inferSelect> {
  const rows = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  const row = rows[0];
  if (row === undefined) throw new Error(`job ${jobId} not found`);
  return row;
}

async function nextAttemptDelaySeconds(tx: DbTransaction, jobId: string): Promise<number> {
  const result = await tx.execute(
    sql`SELECT extract(epoch FROM (${jobs.nextAttemptAt} - now())) AS delay FROM ${jobs} WHERE ${jobs.id} = ${jobId}`
  );
  return Number((result.rows[0] as { delay: string | number }).delay);
}

afterAll(async () => {
  await db.$client.end();
});

describe('completeOk', () => {
  it('flips the row to succeeded with its result', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      expect(await completeOk(tx, fence, { exported: 3 })).toBe('succeeded');
      return readJob(tx, jobId);
    });
    expect(row.status).toBe('succeeded');
    expect(row.result).toEqual({ exported: 3 });
    expect(row.finishedAt).not.toBeNull();
  });

  it('resolves to cancelled when cancel was requested at the fence', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx, { cancelRequested: true });
      expect(await completeOk(tx, fence, null)).toBe('cancelled');
      return readJob(tx, jobId);
    });
    expect(row.status).toBe('cancelled');
  });

  it('loses the fence when the claim counter moved on', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      expect(await completeOk(tx, { ...fence, claims: 0 }, null)).toBe('lost');
      return readJob(tx, jobId);
    });
    expect(row.status).toBe('running');
  });

  it('loses the fence when another claimant holds the row', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      expect(await completeOk(tx, { ...fence, claimedBy: 'claimant-b' }, null)).toBe('lost');
      return readJob(tx, jobId);
    });
    expect(row.status).toBe('running');
  });

  it('loses the fence when the row is no longer running', async () => {
    await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      await tx.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.id, jobId));
      expect(await completeOk(tx, fence, null)).toBe('lost');
    });
  });
});

describe('completeFail', () => {
  it('re-pends with an incremented failure count and the given backoff', async () => {
    const { row, delay } = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      expect(await completeFail(tx, fence, { error: 'gateway-5xx', backoffSeconds: 100 })).toBe(
        'repended'
      );
      return { row: await readJob(tx, jobId), delay: await nextAttemptDelaySeconds(tx, jobId) };
    });
    expect(row.status).toBe('pending');
    expect(row.failures).toBe(1);
    expect(row.claimedAt).toBeNull();
    expect(row.claimedBy).toBeNull();
    expect(row.finishedAt).toBeNull();
    expect(row.errors).toHaveLength(1);
    expect(row.errors[0]).toMatchObject({ claim: 1, error: 'gateway-5xx' });
    expect(delay).toBeGreaterThan(90);
    expect(delay).toBeLessThanOrEqual(100);
  });

  it('resolves to cancelled when cancel was requested at the fence', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx, { cancelRequested: true });
      expect(await completeFail(tx, fence, { error: 'x', backoffSeconds: 1 })).toBe('cancelled');
      return readJob(tx, jobId);
    });
    expect(row.status).toBe('cancelled');
    expect(row.finishedAt).not.toBeNull();
  });

  it('loses the fence for a zombie claimant', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      expect(
        await completeFail(tx, { ...fence, claims: 0 }, { error: 'x', backoffSeconds: 1 })
      ).toBe('lost');
      return readJob(tx, jobId);
    });
    expect(row.failures).toBe(0);
  });

  it('truncates a stored error string at the storage cap', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      await completeFail(tx, fence, { error: 'x'.repeat(5000), backoffSeconds: 1 });
      return readJob(tx, jobId);
    });
    expect(row.errors[0]?.error).toHaveLength(4096);
  });
});

describe('completeYield', () => {
  it('re-pends immediately with the checkpoint and gives back the claim', async () => {
    const { row, delay } = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      expect(await completeYield(tx, fence, { step: 2 })).toBe('repended');
      return { row: await readJob(tx, jobId), delay: await nextAttemptDelaySeconds(tx, jobId) };
    });
    expect(row.status).toBe('pending');
    expect(row.payload).toEqual({ step: 2 });
    expect(row.claims).toBe(0);
    expect(row.failures).toBe(0);
    expect(delay).toBeLessThanOrEqual(0);
  });

  it('resolves to cancelled at the checkpoint boundary when cancel was requested', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx, { cancelRequested: true });
      expect(await completeYield(tx, fence, { step: 2 })).toBe('cancelled');
      return readJob(tx, jobId);
    });
    expect(row.status).toBe('cancelled');
  });

  it('fences out a zombie checkpoint so it cannot corrupt the live claim', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      expect(await completeYield(tx, { ...fence, claims: 0 }, { step: 99 })).toBe('lost');
      return readJob(tx, jobId);
    });
    expect(row.payload).toEqual({ step: 1 });
  });
});

describe('completeDead', () => {
  it('flips the row to dead with the error recorded', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      expect(await completeDead(tx, fence, 'payload-unparseable')).toBe('dead');
      return readJob(tx, jobId);
    });
    expect(row.status).toBe('dead');
    expect(row.finishedAt).not.toBeNull();
    expect(row.errors[0]).toMatchObject({ claim: 1, error: 'payload-unparseable' });
  });

  it('resolves to cancelled when cancel was requested at the fence', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx, { cancelRequested: true });
      expect(await completeDead(tx, fence, 'x')).toBe('cancelled');
      return readJob(tx, jobId);
    });
    expect(row.status).toBe('cancelled');
  });

  it('loses the fence for a zombie claimant', async () => {
    const row = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      expect(await completeDead(tx, { ...fence, claimedBy: 'claimant-b' }, 'x')).toBe('lost');
      return readJob(tx, jobId);
    });
    expect(row.status).toBe('running');
  });
});

describe('the txn-class crash promise', () => {
  // Pins the contract a txn-class handler relies on: a crash before commit
  // rolls back the effect and the terminal transition together, the row
  // stays claimed, and lease expiry alone makes it reclaimable. The shard is
  // `bulk` so the claimBatch call follows this file's lock contract with the
  // committing pass tests.
  it('leaves a crashed pre-commit completion claimed until lease reclaim', async () => {
    await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx, { shard: 'bulk' });
      await expect(
        tx.transaction(async (handlerTx) => {
          // The handler's atomic unit: an effect row plus the fenced transition.
          await handlerTx.insert(jobs).values({
            type: 'test.complete.effect.v1',
            payload: {},
            maxClaims: 8,
            maxFailures: 5,
            leaseSeconds: 60,
          });
          expect(await completeOk(handlerTx, fence, { settled: true })).toBe('succeeded');
          throw new Error('crash-before-commit');
        })
      ).rejects.toThrow('crash-before-commit');
      const row = await readJob(tx, jobId);
      expect(row).toMatchObject({ status: 'running', claimedBy: 'claimant-a', claims: 1 });
      expect(row.result).toBeNull();
      const effects = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.type, 'test.complete.effect.v1'));
      expect(effects).toEqual([]);
      await tx
        .update(jobs)
        .set({ claimedAt: sql`now() - interval '120 seconds'` })
        .where(eq(jobs.id, jobId));
      const batch = await claimBatch(tx, { shard: 'bulk', claimantId: 'claimant-b', limit: 20 });
      expect(batch.find((claimed) => claimed.id === jobId)).toMatchObject({
        status: 'running',
        claims: 2,
        claimedBy: 'claimant-b',
      });
    });
  });
});

describe('heartbeatJob', () => {
  it('touches the lease for the live claimant', async () => {
    const age = await withRollback(async (tx) => {
      const { jobId, fence } = await insertRunningJob(tx);
      await tx
        .update(jobs)
        .set({ claimedAt: sql`now() - interval '50 seconds'` })
        .where(eq(jobs.id, jobId));
      expect(await heartbeatJob(tx, fence)).toBe('alive');
      const result = await tx.execute(
        sql`SELECT extract(epoch FROM (now() - ${jobs.claimedAt})) AS age FROM ${jobs} WHERE ${jobs.id} = ${jobId}`
      );
      return Number((result.rows[0] as { age: string | number }).age);
    });
    expect(age).toBeLessThan(5);
  });

  it('cannot keep a dead lease alive from a zombie claimant', async () => {
    await withRollback(async (tx) => {
      const { fence } = await insertRunningJob(tx);
      expect(await heartbeatJob(tx, { ...fence, claims: 0 })).toBe('lost');
    });
  });
});
