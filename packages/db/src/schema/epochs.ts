import { pgTable, index, integer, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { isNotNull, sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { conversations } from './conversations';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export const epochs = pgTable(
  'epochs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    epochNumber: integer('epoch_number').notNull(),
    // Referential epoch chain (the default NO ACTION still lets a
    // conversation cascade delete its whole chain in one statement)
    previousEpochId: uuid('previous_epoch_id').references((): AnyPgColumn => epochs.id),
    epochPublicKey: bytea('epoch_public_key').notNull(),
    confirmationHash: bytea('confirmation_hash').notNull(),
    chainLink: bytea('chain_link'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('epochs_conversation_epoch_unique').on(table.conversationId, table.epochNumber),
    index('epochs_previous_epoch_id_idx')
      .on(table.previousEpochId)
      .where(isNotNull(table.previousEpochId)),
  ]
);
