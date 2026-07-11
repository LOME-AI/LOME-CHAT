import { LOCAL_NEON_DEV_CONFIG, createDb, jobs } from '@hushbox/db';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  STUCK_PENDING_GRACE_SECONDS,
  STUCK_RUNNING_LEASE_MULTIPLIER,
  findStuckJobs,
  queueStatsFromRows,
  readJobQueueStats,
} from './health.js';
import type { DbTransaction } from '../idempotency/transaction.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for jobs integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

class Rollback extends Error {}

// Rollback-transaction file per the jobs-test contract: it commits nothing
// and every assertion is scoped to rows this file inserted (shard-wide truth
// is not a stable observation on the shared jobs table).
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
  readonly status: 'pending' | 'running';
  readonly nextAttemptSecondsAgo: number;
  readonly cancelRequested?: boolean;
  readonly claims?: number;
  readonly claimedSecondsAgo?: number;
  readonly leaseSeconds?: number;
}

async function insertJob(tx: DbTransaction, seed: JobSeed): Promise<string> {
  const rows = await tx
    .insert(jobs)
    .values({
      type: 'test.health.v1',
      shard: 'bulk',
      payload: {},
      status: seed.status,
      cancelRequested: seed.cancelRequested ?? false,
      claims: seed.claims ?? 0,
      maxClaims: 8,
      maxFailures: 5,
      leaseSeconds: seed.leaseSeconds ?? 60,
      nextAttemptAt: sql`now() - make_interval(secs => ${seed.nextAttemptSecondsAgo})`,
      claimedAt:
        seed.claimedSecondsAgo === undefined
          ? null
          : sql`now() - make_interval(secs => ${seed.claimedSecondsAgo})`,
      claimedBy: seed.claimedSecondsAgo === undefined ? null : 'health-test',
    })
    .returning({ id: jobs.id });
  const row = rows[0];
  if (row === undefined) throw new Error('failed to insert job row');
  return row.id;
}

async function stuckIds(tx: DbTransaction): Promise<Set<string>> {
  const rows = await findStuckJobs(tx, { limit: 100 });
  return new Set(rows.map((row) => row.id));
}

afterAll(async () => {
  await db.$client.end();
});

describe('findStuckJobs', () => {
  it('flags a claimable pending row past the grace window', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'pending',
        nextAttemptSecondsAgo: STUCK_PENDING_GRACE_SECONDS + 60,
      });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(true);
  });

  it('ignores a pending row still inside the grace window', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, { status: 'pending', nextAttemptSecondsAgo: 60 });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(false);
  });

  it('ignores a cancel-requested pending row (the sweep owns it, not the claim path)', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'pending',
        nextAttemptSecondsAgo: STUCK_PENDING_GRACE_SECONDS + 60,
        cancelRequested: true,
      });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(false);
  });

  it('ignores a pending row past its claim budget (the dead-letter pass owns it)', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'pending',
        nextAttemptSecondsAgo: STUCK_PENDING_GRACE_SECONDS + 60,
        claims: 8,
      });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(false);
  });

  it('flags a running row stuck past twice its lease', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'running',
        nextAttemptSecondsAgo: 0,
        claimedSecondsAgo: 60 * STUCK_RUNNING_LEASE_MULTIPLIER + 30,
        leaseSeconds: 60,
      });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(true);
  });

  it('ignores a running row inside twice its lease', async () => {
    const flagged = await withRollback(async (tx) => {
      const id = await insertJob(tx, {
        status: 'running',
        nextAttemptSecondsAgo: 0,
        claimedSecondsAgo: 90,
        leaseSeconds: 60,
      });
      const flaggedIds = await stuckIds(tx);
      return flaggedIds.has(id);
    });
    expect(flagged).toBe(false);
  });

  it('returns at most the limit, oldest due first', async () => {
    const observed = await withRollback(async (tx) => {
      const older = await insertJob(tx, {
        status: 'pending',
        nextAttemptSecondsAgo: STUCK_PENDING_GRACE_SECONDS + 7200,
      });
      await insertJob(tx, {
        status: 'pending',
        nextAttemptSecondsAgo: STUCK_PENDING_GRACE_SECONDS + 3600,
      });
      const rows = await findStuckJobs(tx, { limit: 1 });
      return { count: rows.length, first: rows[0]?.id, older };
    });
    expect(observed.count).toBe(1);
    expect(observed.first).toBe(observed.older);
  });
});

describe('queueStatsFromRows', () => {
  it('reads an empty aggregate result as an empty queue', () => {
    expect(queueStatsFromRows([])).toEqual({ pendingCount: 0, oldestPendingAgeSeconds: null });
  });

  it('passes the aggregate row through', () => {
    expect(queueStatsFromRows([{ pendingCount: 4, oldestPendingAgeSeconds: 77 }])).toEqual({
      pendingCount: 4,
      oldestPendingAgeSeconds: 77,
    });
  });
});

describe('readJobQueueStats', () => {
  it('counts pending rows and ages the oldest one', async () => {
    const stats = await withRollback(async (tx) => {
      const before = await readJobQueueStats(tx);
      await insertJob(tx, { status: 'pending', nextAttemptSecondsAgo: 3600 });
      const after = await readJobQueueStats(tx);
      return { before, after };
    });
    expect(stats.after.pendingCount).toBe(stats.before.pendingCount + 1);
    expect(stats.after.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(3600 - 5);
  });
});
