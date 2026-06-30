import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import type { SQL } from 'drizzle-orm';
import type { DbWriter } from '../idempotency/transaction.js';
import type { JobRow, JobShard } from './registry.js';

export const DEFAULT_SHARD_BATCH_SIZE = 20;
export const BULK_SHARD_BATCH_SIZE = 2;

export function batchSizeForShard(shard: JobShard): number {
  return shard === 'bulk' ? BULK_SHARD_BATCH_SIZE : DEFAULT_SHARD_BATCH_SIZE;
}

/**
 * All lease math runs in SQL against the database clock — Postgres
 * timestamps are never compared to the dispatcher's clock.
 */
const leaseExpired: SQL = sql`${jobs.claimedAt} + make_interval(secs => ${jobs.leaseSeconds}) < now()`;

export interface ClaimBatchParams {
  readonly shard: JobShard;
  readonly claimantId: string;
  readonly limit: number;
}

/**
 * The batch claim: lock-skipping candidate selection plus the claim write in
 * one statement, so two dispatchers can never claim the same row. Claimable:
 * due pending rows and lease-expired running rows (crash recovery is the
 * lease, nothing else), excluding cancel-requested rows (the sweep owns
 * those) and rows past their claim budget (the dead-letter pass owns those).
 */
export async function claimBatch(writer: DbWriter, params: ClaimBatchParams): Promise<JobRow[]> {
  const candidates = writer
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.shard, params.shard),
        sql`${jobs.claims} < ${jobs.maxClaims}`,
        eq(jobs.cancelRequested, false),
        or(
          and(eq(jobs.status, 'pending'), sql`${jobs.nextAttemptAt} <= now()`),
          and(eq(jobs.status, 'running'), leaseExpired)
        )
      )
    )
    .orderBy(asc(jobs.priority), asc(jobs.nextAttemptAt), asc(jobs.id))
    .limit(params.limit)
    .for('update', { skipLocked: true });
  return writer
    .update(jobs)
    .set({
      status: 'running',
      claims: sql`${jobs.claims} + 1`,
      claimedAt: sql`now()`,
      claimedBy: params.claimantId,
    })
    .where(inArray(jobs.id, candidates))
    .returning();
}

export interface SweptJob {
  readonly id: string;
  readonly type: string;
}

/**
 * Pending-cancel is a plain atomic transition; a cancel-requested running
 * row is only taken over once its lease expired — while the lease is live,
 * the claimant's own fence writes resolve the cancel. Returns the swept rows
 * rather than a count so observers can scope to rows they own — the shard is
 * a shared queue, so a shard-wide count is not a stable observation.
 */
export async function sweepCancelRequested(writer: DbWriter, shard: JobShard): Promise<SweptJob[]> {
  return writer
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: sql`now()` })
    .where(
      and(
        eq(jobs.shard, shard),
        eq(jobs.cancelRequested, true),
        or(eq(jobs.status, 'pending'), and(eq(jobs.status, 'running'), leaseExpired))
      )
    )
    .returning({ id: jobs.id, type: jobs.type });
}

export interface DeadLetteredJob {
  readonly id: string;
  readonly type: string;
}

/**
 * Death happens at claim time: any otherwise-claimable row past either
 * budget goes to `dead` before the batch claim runs, so a poison job that
 * kills isolates can never loop a batch. Deliberately not gated on
 * `nextAttemptAt` — an exhausted row mid-backoff is already a verdict, and
 * letting it linger would keep the alarm armed for a row that can never run.
 *
 * Redrive contract: reviving a dead row is an explicit admin UPDATE that
 * resets `status` to pending AND `claims`/`failures`/`nextAttemptAt`
 * together. A status-only redrive is fail-safe — the spent budgets still
 * stand, so this pass instantly re-dead-letters it.
 */
export async function deadLetterExhausted(
  writer: DbWriter,
  shard: JobShard
): Promise<DeadLetteredJob[]> {
  return writer
    .update(jobs)
    .set({
      status: 'dead',
      errors: sql`${jobs.errors} || jsonb_build_array(jsonb_build_object('at', now()::text, 'claim', ${jobs.claims}, 'error', 'retry budget exhausted'::text))`,
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(jobs.shard, shard),
        or(sql`${jobs.claims} >= ${jobs.maxClaims}`, sql`${jobs.failures} >= ${jobs.maxFailures}`),
        or(eq(jobs.status, 'pending'), and(eq(jobs.status, 'running'), leaseExpired))
      )
    )
    .returning({ id: jobs.id, type: jobs.type });
}
