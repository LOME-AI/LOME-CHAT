import { pgTable, bigint, check, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { conversations } from './conversations';

/** Period-keyed (conversationId, month) spending, upserted at settlement. */
export const conversationSpending = pgTable(
  'conversation_spending',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    month: text('month').notNull(),
    spentNanoUsd: bigint('spent_nano_usd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('conversation_spending_conversation_month_unique').on(table.conversationId, table.month),
    check('conversation_spending_month_format', sql`${table.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
  ]
);
