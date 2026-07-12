import { pgTable, index, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { messages } from './messages';
import { users } from './users';

export const sharedMessages = pgTable(
  'shared_messages',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    // A creator's hard deletion severs their public shares
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    wrappedContentKey: bytea('wrapped_content_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('shared_messages_message_id_idx').on(table.messageId),
    index('shared_messages_created_by_idx').on(table.createdBy),
  ]
);
