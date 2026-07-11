import { pgTable, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Intentionally anonymous: no userId column. Holds (deletedAt, ipAddress, userAgent)
// for forensic correlation of "did N deletions cluster around IP X?" — never for
// answering "did THIS user delete their account?" (hard deletion is the privacy
// promise). Written only by the identity slice's deletion executor, in the same
// transaction that deletes the users row (single-writer: identity).
export const accountDeletionEvents = pgTable(
  'account_deletion_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [index('account_deletion_events_deleted_at_idx').on(table.deletedAt)]
);
