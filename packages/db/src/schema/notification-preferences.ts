import { pgTable, boolean, check, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users';

/**
 * Account-level notification controls, one row per user. A missing row means
 * every default (all categories on, no quiet hours) — the notifications slice
 * reads lazily and never backfills. Quiet-hours fields are coherent by DB
 * CHECK: start/end are both-or-neither, and a window requires a timezone to
 * evaluate against (the decision function needs a zone to place the window).
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    globalEnabled: boolean('global_enabled').notNull().default(true),
    messages: boolean('messages').notNull().default(true),
    runCompletion: boolean('run_completion').notNull().default(true),
    membership: boolean('membership').notNull().default(true),
    quietHoursStartMinutes: integer('quiet_hours_start_minutes'),
    quietHoursEndMinutes: integer('quiet_hours_end_minutes'),
    timezone: text('timezone'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'notification_preferences_quiet_hours_both_or_neither',
      sql`(${table.quietHoursStartMinutes} IS NULL) = (${table.quietHoursEndMinutes} IS NULL)`
    ),
    check(
      'notification_preferences_quiet_hours_timezone',
      sql`${table.quietHoursStartMinutes} IS NULL OR ${table.timezone} IS NOT NULL`
    ),
  ]
);
