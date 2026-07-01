import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users';

/**
 * Per-user announcement-banner dismissal: exactly one row per user holding the
 * message-set hash they last dismissed. The read filters by the current hash, so
 * a new set re-shows automatically and the row is simply overwritten on the next
 * dismiss — no GC job. Modeled on `preferences`; owned single-writer by the
 * announcements slice.
 */
export const bannerDismissals = pgTable('banner_dismissals', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  messageSetHash: text('message_set_hash').notNull(),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
