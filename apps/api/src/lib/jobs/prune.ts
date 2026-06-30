import { and, eq, inArray, sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import type { DbWriter } from '../idempotency/transaction.js';

/** `succeeded` rows prune after seven days; `dead`/`cancelled` live forever. */
export const SUCCEEDED_RETENTION_DAYS = 7;

export interface PruneParams {
  readonly batchSize: number;
}

/**
 * The retention delete for succeeded rows, batched so a backlog never holds
 * long locks (the partial index on `finishedAt` makes the scan cheap). The
 * retention cron wires this; read paths never depend on it having run.
 */
export async function pruneSucceededJobs(writer: DbWriter, params: PruneParams): Promise<number> {
  const expired = writer
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'succeeded'),
        sql`${jobs.finishedAt} < now() - make_interval(days => ${SUCCEEDED_RETENTION_DAYS})`
      )
    )
    .limit(params.batchSize);
  const deleted = await writer
    .delete(jobs)
    .where(inArray(jobs.id, expired))
    .returning({ id: jobs.id });
  return deleted.length;
}
