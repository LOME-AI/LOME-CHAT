import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BULK_SHARD_BATCH_SIZE,
  DEFAULT_SHARD_BATCH_SIZE,
  batchSizeForShard,
  claimBatch,
  deadLetterExhausted,
  sweepCancelRequested,
} from './claim.js';
import type { DbTransaction } from '../idempotency/transaction.js';
import type { JobShard } from './registry.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * The jobs table is one shared queue and the dispatcher-pass tests commit
 * claimable default-shard rows in parallel, so rollback alone is not
 * isolation here. Two rules keep this file sound: every shard-wide operation
 * (claim, sweep, dead-letter) runs on the `bulk` shard — no test file
 * commits claimable bulk rows, so this file's transient FOR UPDATE locks can
 * never lock-skip the pass tests' committed rows — and every assertion is
 * scoped to this file's own rows, never to shard-wide truth.
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

const TEST_TYPE = 'test.claim.v1';

function ownRows<Row extends { type: string }>(rows: Row[]): Row[] {
  return rows.filter((row) => row.type === TEST_TYPE);
}

interface JobSeed {
  readonly shard?: JobShard;
  readonly status?: 'pending' | 'running';
  readonly priority?: number;
  /** Seconds relative to now; negative = already due. */
  readonly nextAttemptInSeconds?: number;
  /** Seconds ago the row was claimed; implies status running unless set. */
  readonly claimedSecondsAgo?: number;
  readonly claims?: number;
  readonly failures?: number;
  readonly maxClaims?: number;
  readonly maxFailures?: number;
  readonly leaseSeconds?: number;
  readonly cancelRequested?: boolean;
}

async function insertJob(tx: DbTransaction, seed: JobSeed = {}): Promise<string> {
  const { claimedSecondsAgo, nextAttemptInSeconds = -1, cancelRequested = false, ...rest } = seed;
  const rows = await tx
    .insert(jobs)
    .values({
      type: TEST_TYPE,
      payload: {},
      shard: 'bulk',
      status: 'pending',
      priority: 0,
      claims: 0,
      failures: 0,
      maxClaims: 8,
      maxFailures: 5,
      leaseSeconds: 60,
      // Seeds only carry defined keys, so the spread overrides the defaults.
      ...rest,
      nextAttemptAt: sql`now() + make_interval(secs => ${nextAttemptInSeconds}::double precision)`,
      cancelRequested,
      ...(claimedSecondsAgo === undefined
        ? {}
        : {
            claimedAt: sql`now() - make_interval(secs => ${claimedSecondsAgo}::double precision)`,
            claimedBy: 'previous-claimant',
          }),
    })
    .returning({ id: jobs.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert job');
  return row.id;
}

async function statusOf(tx: DbTransaction, jobId: string): Promise<string> {
  const rows = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId));
  const row = rows[0];
  if (row === undefined) throw new Error(`job ${jobId} not found`);
  return row.status;
}

afterAll(async () => {
  await db.$client.end();
});

describe('batchSizeForShard', () => {
  it('claims twenty at a time on the default shard', () => {
    expect(batchSizeForShard('default')).toBe(DEFAULT_SHARD_BATCH_SIZE);
  });

  it('claims two at a time on the bulk shard', () => {
    expect(batchSizeForShard('bulk')).toBe(BULK_SHARD_BATCH_SIZE);
  });
});

describe('claimBatch', () => {
  it('claims a due pending row for the claimant', async () => {
    const claimed = await withRollback(async (tx) => {
      const jobId = await insertJob(tx);
      const batch = await claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });
      return batch.find((row) => row.id === jobId);
    });
    expect(claimed).toMatchObject({ status: 'running', claims: 1, claimedBy: 'me' });
    expect(claimed?.claimedAt).not.toBeNull();
  });

  it('claims in priority order, then by nextAttemptAt, within the limit', async () => {
    const ids = await withRollback(async (tx) => {
      const low = await insertJob(tx, { priority: 5, nextAttemptInSeconds: -100 });
      const urgent = await insertJob(tx, { priority: -1, nextAttemptInSeconds: -10 });
      const older = await insertJob(tx, { priority: 0, nextAttemptInSeconds: -50 });
      const newer = await insertJob(tx, { priority: 0, nextAttemptInSeconds: -20 });
      const batch = await claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 3 });
      return { low, urgent, older, newer, claimed: new Set(ownRows(batch).map((row) => row.id)) };
    });
    expect(ids.claimed).toEqual(new Set([ids.urgent, ids.older, ids.newer]));
    expect(ids.claimed.has(ids.low)).toBe(false);
  });

  it('skips rows scheduled in the future', async () => {
    const batch = await withRollback(async (tx) => {
      await insertJob(tx, { nextAttemptInSeconds: 3600 });
      return claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });
    });
    expect(ownRows(batch)).toEqual([]);
  });

  it('skips cancel-requested pending rows', async () => {
    const batch = await withRollback(async (tx) => {
      await insertJob(tx, { cancelRequested: true });
      return claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });
    });
    expect(ownRows(batch)).toEqual([]);
  });

  it('skips running rows whose lease is still live', async () => {
    const batch = await withRollback(async (tx) => {
      await insertJob(tx, { status: 'running', claims: 1, claimedSecondsAgo: 10 });
      return claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });
    });
    expect(ownRows(batch)).toEqual([]);
  });

  it('reclaims a running row whose lease expired', async () => {
    const claimed = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { status: 'running', claims: 1, claimedSecondsAgo: 120 });
      const batch = await claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });
      return batch.find((row) => row.id === jobId);
    });
    expect(claimed).toMatchObject({ status: 'running', claims: 2, claimedBy: 'me' });
  });

  it('skips rows that spent their claim budget', async () => {
    const batch = await withRollback(async (tx) => {
      await insertJob(tx, { claims: 8 });
      return claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });
    });
    expect(ownRows(batch)).toEqual([]);
  });

  it('claims only rows of its shard', async () => {
    const batch = await withRollback(async (tx) => {
      await insertJob(tx, { shard: 'default' });
      return claimBatch(tx, { shard: 'bulk', claimantId: 'me', limit: 20 });
    });
    expect(ownRows(batch)).toEqual([]);
  });
});

describe('sweepCancelRequested', () => {
  it('cancels a cancel-requested pending row', async () => {
    const { swept, jobId, status } = await withRollback(async (tx) => {
      const id = await insertJob(tx, { cancelRequested: true });
      const rows = await sweepCancelRequested(tx, 'bulk');
      return { swept: rows, jobId: id, status: await statusOf(tx, id) };
    });
    expect(ownRows(swept)).toEqual([{ id: jobId, type: TEST_TYPE }]);
    expect(status).toBe('cancelled');
  });

  it('cancels a cancel-requested running row once its lease expired', async () => {
    const { swept, jobId, status } = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'running',
        claims: 1,
        claimedSecondsAgo: 120,
        cancelRequested: true,
      });
      const rows = await sweepCancelRequested(tx, 'bulk');
      return { swept: rows, jobId: id, status: await statusOf(tx, id) };
    });
    expect(ownRows(swept)).toEqual([{ id: jobId, type: TEST_TYPE }]);
    expect(status).toBe('cancelled');
  });

  it('leaves a live-leased running row to its claimant fence', async () => {
    const { swept, status } = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, {
        status: 'running',
        claims: 1,
        claimedSecondsAgo: 10,
        cancelRequested: true,
      });
      const rows = await sweepCancelRequested(tx, 'bulk');
      return { swept: rows, status: await statusOf(tx, jobId) };
    });
    expect(ownRows(swept)).toEqual([]);
    expect(status).toBe('running');
  });

  it('sweeps only its shard', async () => {
    const { swept, status } = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { shard: 'default', cancelRequested: true });
      const rows = await sweepCancelRequested(tx, 'bulk');
      return { swept: rows, status: await statusOf(tx, jobId) };
    });
    expect(ownRows(swept)).toEqual([]);
    expect(status).toBe('pending');
  });
});

describe('deadLetterExhausted', () => {
  it('dead-letters a pending row that spent its claim budget', async () => {
    const { jobId, dead, status } = await withRollback(async (tx) => {
      const id = await insertJob(tx, { claims: 8 });
      const letters = await deadLetterExhausted(tx, 'bulk');
      return { jobId: id, dead: letters, status: await statusOf(tx, id) };
    });
    expect(ownRows(dead)).toEqual([{ id: jobId, type: TEST_TYPE }]);
    expect(status).toBe('dead');
  });

  it('dead-letters a failures-exhausted row even before its backoff elapses', async () => {
    const status = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { failures: 5, nextAttemptInSeconds: 3600 });
      await deadLetterExhausted(tx, 'bulk');
      return statusOf(tx, jobId);
    });
    expect(status).toBe('dead');
  });

  it('dead-letters an exhausted running row once its lease expired', async () => {
    const status = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { status: 'running', claims: 8, claimedSecondsAgo: 120 });
      await deadLetterExhausted(tx, 'bulk');
      return statusOf(tx, jobId);
    });
    expect(status).toBe('dead');
  });

  it('leaves a live-leased exhausted running row to finish', async () => {
    const status = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { status: 'running', claims: 8, claimedSecondsAgo: 10 });
      await deadLetterExhausted(tx, 'bulk');
      return statusOf(tx, jobId);
    });
    expect(status).toBe('running');
  });

  it('records the verdict in the error history with a finish time', async () => {
    const row = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { claims: 8, failures: 3 });
      await deadLetterExhausted(tx, 'bulk');
      const rows = await tx.select().from(jobs).where(eq(jobs.id, jobId));
      return rows[0];
    });
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.errors[0]).toMatchObject({ claim: 8, error: 'retry budget exhausted' });
  });

  it('leaves healthy rows alone', async () => {
    const status = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { claims: 3, failures: 2 });
      await deadLetterExhausted(tx, 'bulk');
      return statusOf(tx, jobId);
    });
    expect(status).toBe('pending');
  });

  it('dead-letters only its shard', async () => {
    const status = await withRollback(async (tx) => {
      const jobId = await insertJob(tx, { shard: 'default', claims: 8 });
      await deadLetterExhausted(tx, 'bulk');
      return statusOf(tx, jobId);
    });
    expect(status).toBe('pending');
  });
});
