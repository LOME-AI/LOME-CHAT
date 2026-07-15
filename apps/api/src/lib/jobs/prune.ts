import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import type { SQL } from 'drizzle-orm';
import type { DbWriter } from '../idempotency/transaction.js';

/** `succeeded` rows prune after seven days; `dead`/`cancelled` live forever. */
export const SUCCEEDED_RETENTION_DAYS = 7;

/**
 * Discarded rows keep a longer window than succeeded ones because the row is
 * the only restore target — pruning it forecloses the discard's registered
 * inverse, so the window is the undo horizon, not just debris retention.
 */
export const DISCARDED_RETENTION_DAYS = 30;

export interface PruneParams {
  readonly batchSize: number;
}

/** Batched retention delete so a backlog never holds long locks. */
async function pruneExpired(
  writer: DbWriter,
  expiredCondition: SQL | undefined,
  batchSize: number
): Promise<number> {
  const expired = writer
    .select({ id: jobs.id })
    .from(jobs)
    .where(expiredCondition)
    .limit(batchSize);
  const deleted = await writer
    .delete(jobs)
    .where(inArray(jobs.id, expired))
    .returning({ id: jobs.id });
  return deleted.length;
}

/**
 * The retention delete for succeeded rows (the partial index on `finishedAt`
 * makes the scan cheap). The retention cron wires this; read paths never
 * depend on it having run.
 */
export async function pruneSucceededJobs(writer: DbWriter, params: PruneParams): Promise<number> {
  return pruneExpired(
    writer,
    and(
      eq(jobs.status, 'succeeded'),
      sql`${jobs.finishedAt} < now() - make_interval(days => ${SUCCEEDED_RETENTION_DAYS})`
    ),
    params.batchSize
  );
}

/**
 * The retention delete for discarded dead rows. The dead set is an inbox:
 * only discarded rows prune — an unresolved dead row is never auto-deleted —
 * and `discardedAt` is set only on dead rows. The partial index on
 * `discarded_at WHERE discarded_at IS NOT NULL` backs this scan.
 */
export async function pruneDiscardedJobs(writer: DbWriter, params: PruneParams): Promise<number> {
  return pruneExpired(
    writer,
    and(
      isNotNull(jobs.discardedAt),
      sql`${jobs.discardedAt} < now() - make_interval(days => ${DISCARDED_RETENTION_DAYS})`
    ),
    params.batchSize
  );
}
