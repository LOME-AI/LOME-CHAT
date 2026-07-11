import { inArray, sql } from 'drizzle-orm';
import { accountDeletionEvents } from '@hushbox/db';
import type { DbWriter } from '../lib/idempotency/transaction.js';

/**
 * Anonymous deletion events (forensic IP/UA correlation, no user link) are
 * kept ninety days and then purged — the legacy retention window, carried
 * forward. Batched like every retention delete; the deleted_at index backs
 * the scan, and nothing reads these rows on a hot path.
 */
export const DELETION_EVENT_RETENTION_DAYS = 90;

export interface DeletionEventsPurgeParams {
  readonly batchSize: number;
}

export async function purgeExpiredAccountDeletionEvents(
  writer: DbWriter,
  params: DeletionEventsPurgeParams
): Promise<number> {
  const expired = writer
    .select({ id: accountDeletionEvents.id })
    .from(accountDeletionEvents)
    .where(
      sql`${accountDeletionEvents.deletedAt} < now() - make_interval(days => ${DELETION_EVENT_RETENTION_DAYS})`
    )
    .limit(params.batchSize);
  const deleted = await writer
    .delete(accountDeletionEvents)
    .where(inArray(accountDeletionEvents.id, expired))
    .returning({ id: accountDeletionEvents.id });
  return deleted.length;
}
