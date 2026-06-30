import { pgTable, index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { isNotNull, sql } from 'drizzle-orm';

import { conversations } from './conversations';
import { messages } from './messages';

export const conversationForks = pgTable(
  'conversation_forks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tipMessageId: uuid('tip_message_id').references(() => messages.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('conversation_forks_conversation_name_unique').on(table.conversationId, table.name),
    index('conversation_forks_tip_message_id_idx')
      .on(table.tipMessageId)
      .where(isNotNull(table.tipMessageId)),
  ]
);
