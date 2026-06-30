import { pgTable, bigint, check, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users';

/**
 * The free-tier allowance is period-keyed (userId, day) — rows upserted
 * at settlement, UTC-keyed, no reset jobs.
 */
export const allowanceSpending = pgTable(
  'allowance_spending',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    spentNanoUsd: bigint('spent_nano_usd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('allowance_spending_user_day_unique').on(table.userId, table.day),
    check('allowance_spending_day_format', sql`${table.day} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  ]
);
