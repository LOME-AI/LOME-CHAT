import { pgTable, bigint, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { conversationMembers } from './conversation-members';

/**
 * One durable row per member (cumulative forever, no period, no reset job).
 * budgetNanoUsd is the owner-set per-member cap — configuration that exists
 * independent of spend; an absent row means a zero cap (deny). spentNanoUsd
 * accumulates indefinitely.
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
    budgetNanoUsd: bigint('budget_nano_usd', { mode: 'bigint' }).notNull(),
    spentNanoUsd: bigint('spent_nano_usd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique('member_budgets_member_unique').on(table.memberId)]
);
