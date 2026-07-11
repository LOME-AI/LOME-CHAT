import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { idempotencyKeys } from '@hushbox/db';
import { IDEMPOTENCY_PURGE_TTL_SECONDS } from './config.js';
import type { DbWriter } from './transaction.js';

export interface IdempotencyPurgeParams {
  readonly batchSize: number;
}

/**
 * The TTL retention delete for terminal key rows, batched so a backlog never
 * holds long locks (the partial index on `completedAt` makes the scan cheap).
 * Non-terminal rows have a null `completedAt` and are skipped by predicate —
 * a live claim can never be purged, and read paths never depend on the purge
 * having run. The TTL floor in config.ts guarantees a purged `succeeded` row
 * is already past every replay horizon.
 */
export async function purgeTerminalIdempotencyKeys(
  writer: DbWriter,
  params: IdempotencyPurgeParams
): Promise<number> {
  const expired = writer
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(
      and(
        isNotNull(idempotencyKeys.completedAt),
        sql`${idempotencyKeys.completedAt} < now() - make_interval(secs => ${IDEMPOTENCY_PURGE_TTL_SECONDS})`
      )
    )
    .limit(params.batchSize);
  const deleted = await writer
    .delete(idempotencyKeys)
    .where(inArray(idempotencyKeys.id, expired))
    .returning({ id: idempotencyKeys.id });
  return deleted.length;
}
