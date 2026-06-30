import { pgTable, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { conversations } from './conversations';

/**
 * revokedAt + expiresAt are enforced lazily at the read path — a
 * predicate, not a process.
 */
export const sharedLinks = pgTable(
  'shared_links',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    linkPublicKey: bytea('link_public_key').notNull().unique(),
    displayName: text('display_name'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('shared_links_conversation_id_idx').on(table.conversationId)]
);
