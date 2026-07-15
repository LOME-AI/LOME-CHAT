import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { claimBatch } from './claim.js';
import { discardJob, redriveJob, restoreJob } from './lifecycle.js';
import { DISCARDED_RETENTION_DAYS, pruneDiscardedJobs } from './prune.js';
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

interface JobSeed {
  readonly status?: 'pending' | 'running' | 'succeeded' | 'cancelled' | 'dead';
  readonly claims?: number;
  readonly failures?: number;
  readonly cancelRequested?: boolean;
  readonly discardedDaysAgo?: number;
  readonly finished?: boolean;
}

async function insertJob(tx: DbTransaction, seed: JobSeed = {}): Promise<string> {
  const { discardedDaysAgo, finished = true, ...rest } = seed;
  const rows = await tx
    .insert(jobs)
    .values({
      type: 'test.lifecycle.v1',
      payload: {},
      shard: 'bulk',
      status: 'dead',
      claims: 8,
      failures: 5,
      maxClaims: 8,
      maxFailures: 5,
      leaseSeconds: 60,
      // Backoff pushed the last attempt far out; a redrive must override it.
      nextAttemptAt: sql`now() + make_interval(secs => 3600)`,
      ...rest,
      ...(finished ? { finishedAt: sql`now()` } : {}),
      ...(discardedDaysAgo === undefined
        ? {}
        : { discardedAt: sql`now() - make_interval(days => ${discardedDaysAgo})` }),
    })
    .returning({ id: jobs.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert job');
  return row.id;
}

interface RowState {
  readonly status: string;
  readonly claims: number;
  readonly failures: number;
  readonly discardedAt: Date | null;
  readonly nextAttemptDue: boolean;
}

async function rowState(tx: DbTransaction, jobId: string): Promise<RowState> {
  const rows = await tx
    .select({
      status: jobs.status,
      claims: jobs.claims,
      failures: jobs.failures,
      discardedAt: jobs.discardedAt,
      nextAttemptDue: sql<boolean>`${jobs.nextAttemptAt} <= now()`,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  const row = rows[0];
  if (row === undefined) throw new Error(`job ${jobId} not found`);
  return row;
}

afterAll(async () => {
  await db.$client.end();
});

describe('redriveJob', () => {
  it('resets a dead row to pending with claims, failures, and next attempt together', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx);
      const result = await redriveJob(tx, jobId);
      return { result, row: await rowState(tx, jobId) };
    });
    expect(state.result).toEqual({ outcome: 'redriven', shard: 'bulk' });
    expect(state.row.status).toBe('pending');
    expect(state.row.claims).toBe(0);
    expect(state.row.failures).toBe(0);
    expect(state.row.nextAttemptDue).toBe(true);
  });

  it('makes the redriven row claimable by exactly one dispatcher pass', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx);
      await redriveJob(tx, jobId);
      const first = await claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });
      const second = await claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });
      return {
        firstClaimed: first.filter((row) => row.id === jobId).length,
        secondClaimed: second.filter((row) => row.id === jobId).length,
      };
    });
    expect(state.firstClaimed).toBe(1);
    expect(state.secondClaimed).toBe(0);
  });

  it('treats a second redrive of the same row as a no-op', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx);
      const first = await redriveJob(tx, jobId);
      const second = await redriveJob(tx, jobId);
      return { first, second, row: await rowState(tx, jobId) };
    });
    expect(state.first).toEqual({ outcome: 'redriven', shard: 'bulk' });
    expect(state.second).toEqual({ outcome: 'already-active' });
    expect(state.row.status).toBe('pending');
  });

  it('does not reset a running row a dispatcher already claimed', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx);
      await redriveJob(tx, jobId);
      await claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });
      const result = await redriveJob(tx, jobId);
      return { result, row: await rowState(tx, jobId) };
    });
    expect(state.result).toEqual({ outcome: 'already-active' });
    expect(state.row.status).toBe('running');
    expect(state.row.claims).toBe(1);
  });

  it('refuses a discarded row until it is restored', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { discardedDaysAgo: 0 });
      const result = await redriveJob(tx, jobId);
      return { result, row: await rowState(tx, jobId) };
    });
    expect(state.result).toEqual({ outcome: 'refused', reason: 'discarded' });
    expect(state.row.status).toBe('dead');
  });

  it('refuses a row that is not dead', async () => {
    const result = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { status: 'succeeded' });
      return redriveJob(tx, jobId);
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'not-dead' });
  });

  it('refuses an unknown job id', async () => {
    const result = await withRollback((tx) => redriveJob(tx, crypto.randomUUID()));
    expect(result).toEqual({ outcome: 'refused', reason: 'not-found' });
  });

  it('clears a stale cancel request so the redriven row is not instantly swept', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { cancelRequested: true });
      const result = await redriveJob(tx, jobId);
      const rows = await tx
        .select({ cancelRequested: jobs.cancelRequested })
        .from(jobs)
        .where(eq(jobs.id, jobId));
      return { result, cancelRequested: rows[0]?.cancelRequested };
    });
    expect(state.result).toEqual({ outcome: 'redriven', shard: 'bulk' });
    expect(state.cancelRequested).toBe(false);
  });
});

describe('discardJob', () => {
  it('marks a dead row discarded', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx);
      const result = await discardJob(tx, jobId);
      return { result, row: await rowState(tx, jobId) };
    });
    expect(state.result).toBe('discarded');
    expect(state.row.status).toBe('dead');
    expect(state.row.discardedAt).not.toBeNull();
  });

  it('treats a second discard as an idempotent no-op that keeps the first timestamp', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { discardedDaysAgo: 2 });
      const result = await discardJob(tx, jobId);
      return { result, row: await rowState(tx, jobId) };
    });
    expect(state.result).toBe('already-discarded');
    expect(state.row.discardedAt?.getTime()).toBeLessThan(Date.now() - 24 * 60 * 60 * 1000);
  });

  it('refuses a row that is not dead', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { status: 'pending', claims: 0, failures: 0 });
      const result = await discardJob(tx, jobId);
      return { result, row: await rowState(tx, jobId) };
    });
    expect(state.result).toBe('not-dead');
    expect(state.row.discardedAt).toBeNull();
  });

  it('refuses an unknown job id', async () => {
    const result = await withRollback((tx) => discardJob(tx, crypto.randomUUID()));
    expect(result).toBe('not-found');
  });
});

describe('restoreJob', () => {
  it('returns a discarded row to the dead inbox without redriving it', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { discardedDaysAgo: 1 });
      const result = await restoreJob(tx, jobId);
      return { result, row: await rowState(tx, jobId) };
    });
    expect(state.result).toBe('restored');
    expect(state.row.status).toBe('dead');
    expect(state.row.discardedAt).toBeNull();
    expect(state.row.claims).toBe(8);
    expect(state.row.failures).toBe(5);
  });

  it('treats restoring an undiscarded row as an idempotent no-op', async () => {
    const result = await withRollback(async (tx) => {
      const jobId = await insertJob(tx);
      return restoreJob(tx, jobId);
    });
    expect(result).toBe('not-discarded');
  });

  it('refuses an unknown job id', async () => {
    const result = await withRollback((tx) => restoreJob(tx, crypto.randomUUID()));
    expect(result).toBe('not-found');
  });

  it('makes a restored row redrivable again', async () => {
    const result = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { discardedDaysAgo: 1 });
      await restoreJob(tx, jobId);
      return redriveJob(tx, jobId);
    });
    expect(result).toEqual({ outcome: 'redriven', shard: 'bulk' });
  });
});

describe('pruneDiscardedJobs', () => {
  it('deletes discarded rows past the retention window', async () => {
    const state = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { discardedDaysAgo: DISCARDED_RETENTION_DAYS + 1 });
      const pruned = await pruneDiscardedJobs(tx, { batchSize: 100 });
      const remaining = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId));
      return { pruned, stillThere: remaining.length === 1 };
    });
    expect(state.pruned).toBeGreaterThanOrEqual(1);
    expect(state.stillThere).toBe(false);
  });

  it('keeps discarded rows inside the retention window', async () => {
    const kept = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { discardedDaysAgo: DISCARDED_RETENTION_DAYS - 1 });
      await pruneDiscardedJobs(tx, { batchSize: 100 });
      const remaining = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId));
      return remaining.length === 1;
    });
    expect(kept).toBe(true);
  });

  it('never touches an undischarged dead row, no matter its age', async () => {
    const kept = await withRollback(async (tx) => {
      const jobId = await insertJob(tx);
      await tx
        .update(jobs)
        .set({ finishedAt: sql`now() - make_interval(days => 400)` })
        .where(eq(jobs.id, jobId));
      await pruneDiscardedJobs(tx, { batchSize: 100 });
      const remaining = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId));
      return remaining.length === 1;
    });
    expect(kept).toBe(true);
  });

  it('deletes at most the batch size per call', async () => {
    const counts = await withRollback(async (tx) => {
      await insertJob(tx, { discardedDaysAgo: DISCARDED_RETENTION_DAYS + 1 });
      await insertJob(tx, { discardedDaysAgo: DISCARDED_RETENTION_DAYS + 2 });
      await insertJob(tx, { discardedDaysAgo: DISCARDED_RETENTION_DAYS + 3 });
      const first = await pruneDiscardedJobs(tx, { batchSize: 2 });
      const second = await pruneDiscardedJobs(tx, { batchSize: 2 });
      return { first, second };
    });
    expect(counts.first).toBe(2);
    expect(counts.second).toBe(1);
  });
});
