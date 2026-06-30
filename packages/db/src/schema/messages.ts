import { pgTable, foreignKey, index, integer, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { isNotNull, sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { conversations } from './conversations';
import { messageSenderTypeEnum } from './enums';
import { epochs } from './epochs';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export const messages = pgTable(
  'messages',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderType: messageSenderTypeEnum('sender_type').notNull(),
    // Deliberately not an FK: a sender may be a link-guest principal that has
    // no users row; account deletion nulls it in the deletion path instead.
    senderId: uuid('sender_id'),
    wrappedContentKey: bytea('wrapped_content_key').notNull(),
    epochNumber: integer('epoch_number').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    parentMessageId: uuid('parent_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    /**
     * Per-turn identifier shared by every message persisted in one
     * settlement; multi-model peers are siblings with equal batchIds.
     */
    batchId: uuid('batch_id')
      .notNull()
      .default(sql`uuidv7()`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The conversation DO's strict serialization, DB-enforced
    unique('messages_conversation_sequence_unique').on(table.conversationId, table.sequenceNumber),
    // messages.epochNumber → epochs (epoch rows are never deleted
    // individually, so the cascade only ever fires inside a conversation
    // cascade)
    foreignKey({
      columns: [table.conversationId, table.epochNumber],
      foreignColumns: [epochs.conversationId, epochs.epochNumber],
      name: 'messages_conversation_epoch_fk',
    }).onDelete('cascade'),
    index('messages_conversation_epoch_idx').on(table.conversationId, table.epochNumber),
    index('messages_parent_message_id_idx')
      .on(table.parentMessageId)
      .where(isNotNull(table.parentMessageId)),
    // Backs the deletion path's sender_id scrub without a seq scan
    index('messages_sender_id_idx').on(table.senderId).where(isNotNull(table.senderId)),
  ]
);
