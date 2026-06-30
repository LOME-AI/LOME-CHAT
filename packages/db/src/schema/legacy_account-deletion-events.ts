import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Intentionally anonymous: no userId column. Holds (deletedAt, ipAddress, userAgent)
// for forensic correlation of "did N deletions cluster around IP X?" — not for
// answering "did THIS user delete their account?". Retention purged by
// purgeExpiredDeletionEvents in the daily scheduled handler.
export const accountDeletionEvents = pgTable(
  'account_deletion_events',
  {
    id: text('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [index('account_deletion_events_deleted_at_idx').on(table.deletedAt)]
);
