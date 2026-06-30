import { lt } from 'drizzle-orm';

import { accountDeletionEvents } from './schema/legacy_account-deletion-events';
import type { Database } from './legacy_client';

export async function purgeExpiredDeletionEvents(
  db: Database,
  now: Date,
  retentionDays = 90
): Promise<{ purged: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await db
    .delete(accountDeletionEvents)
    .where(lt(accountDeletionEvents.deletedAt, cutoff))
    .returning({ id: accountDeletionEvents.id });

  return { purged: result.length };
}
