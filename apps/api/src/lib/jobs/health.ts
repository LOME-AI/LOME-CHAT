import { and, asc, eq, or, sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import type { DbWriter } from '../idempotency/transaction.js';
import type { JobShard } from './registry.js';

/**
 * Read-only probes for the jobs-health auditor (the 15-minute cron). The
 * auditor detects and pages; the one mutation it triggers is the blessed
 * `wake()` clock-nudge, which lives with the caller — nothing here writes.
 * Both probes stay inside the claim partial index's predicate
 * (`status IN ('pending','running')`), so scans never touch terminal rows.
 */

/** A due pending row unclaimed this long past `nextAttemptAt` is stuck. */
export const STUCK_PENDING_GRACE_SECONDS = 600;

/** A running row is stuck once it has held its lease this many times over. */
export const STUCK_RUNNING_LEASE_MULTIPLIER = 2;

export interface StuckJobRow {
  readonly id: string;
  readonly type: string;
  readonly shard: JobShard;
  readonly status: 'pending' | 'running';
}

export interface FindStuckJobsParams {
  readonly limit: number;
}

/**
 * Stuck = the dispatcher should have acted and has not: a claimable pending
 * row (the claim path's own eligibility — not cancel-requested, claim budget
 * left) due past the grace window, or a running row past twice its lease
 * (one lease expiry is normal crash recovery; two means no dispatcher pass
 * reclaimed it). All clock math runs on the database clock.
 */
export async function findStuckJobs(
  writer: DbWriter,
  params: FindStuckJobsParams
): Promise<StuckJobRow[]> {
  const rows = await writer
    .select({ id: jobs.id, type: jobs.type, shard: jobs.shard, status: jobs.status })
    .from(jobs)
    .where(
      or(
        and(
          eq(jobs.status, 'pending'),
          eq(jobs.cancelRequested, false),
          sql`${jobs.claims} < ${jobs.maxClaims}`,
          sql`${jobs.nextAttemptAt} < now() - make_interval(secs => ${STUCK_PENDING_GRACE_SECONDS})`
        ),
        and(
          eq(jobs.status, 'running'),
          sql`${jobs.claimedAt} + make_interval(secs => ${jobs.leaseSeconds} * ${STUCK_RUNNING_LEASE_MULTIPLIER}) < now()`
        )
      )
    )
    .orderBy(asc(jobs.nextAttemptAt), asc(jobs.id))
    .limit(params.limit);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    shard: row.shard,
    status: row.status === 'running' ? 'running' : 'pending',
  }));
}

export interface JobQueueStats {
  readonly pendingCount: number;
  /**
   * Age of the oldest pending row's `nextAttemptAt`; negative when the whole
   * backlog is future-scheduled, null when nothing is pending.
   */
  readonly oldestPendingAgeSeconds: number | null;
}

interface QueueStatsRow {
  readonly pendingCount: number;
  readonly oldestPendingAgeSeconds: number | null;
}

/** Maps the aggregate result; an empty result set reads as an empty queue. */
export function queueStatsFromRows(rows: readonly QueueStatsRow[]): JobQueueStats {
  const row = rows[0];
  return row === undefined
    ? { pendingCount: 0, oldestPendingAgeSeconds: null }
    : { pendingCount: row.pendingCount, oldestPendingAgeSeconds: row.oldestPendingAgeSeconds };
}

export async function readJobQueueStats(writer: DbWriter): Promise<JobQueueStats> {
  return queueStatsFromRows(
    await writer
      .select({
        pendingCount: sql<number>`count(*)::int`,
        oldestPendingAgeSeconds: sql<
          number | null
        >`floor(extract(epoch from now() - min(${jobs.nextAttemptAt})))::int`,
      })
      .from(jobs)
      .where(eq(jobs.status, 'pending'))
  );
}
