import { pgTable, bigint, check, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { conversationMembers } from './conversation-members';

/**
 * Period-keyed (memberId, month) rows upserted at settlement — no reset
 * jobs; rollover is a new row by construction. Periods are UTC-keyed; a run
 * settles into the period of its settlement commit time. budgetNanoUsd is
 * the cap in effect for that period, snapshotted at upsert.
 */
export const memberBudgets = pgTable(
  'member_budgets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    memberId: uuid('member_id')
      .notNull()
      .references(() => conversationMembers.id, { onDelete: 'cascade' }),
    month: text('month').notNull(),
    budgetNanoUsd: bigint('budget_nano_usd', { mode: 'bigint' }).notNull(),
    spentNanoUsd: bigint('spent_nano_usd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('member_budgets_member_month_unique').on(table.memberId, table.month),
    check('member_budgets_month_format', sql`${table.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
  ]
);
