import { pgTable, bigint, index, integer, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { users } from './users';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: bytea('title').notNull(),
    titleEpochNumber: integer('title_epoch_number').notNull().default(1),
    currentEpoch: integer('current_epoch').notNull().default(1),
    nextSequence: integer('next_sequence').notNull().default(1),
    conversationBudgetNanoUsd: bigint('conversation_budget_nano_usd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('conversations_user_id_idx').on(table.userId)]
);
