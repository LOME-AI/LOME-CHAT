import { pgTable, bigint, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { conversations } from './conversations';

/**
 * One durable row per conversation (cumulative forever, no period). Tracks the
 * conversation's total spend; the per-conversation cap it is checked against
 * lives on conversations.conversationBudgetNanoUsd.
 */
export const conversationSpending = pgTable(
  'conversation_spending',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    spentNanoUsd: bigint('spent_nano_usd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique('conversation_spending_conversation_unique').on(table.conversationId)]
);
