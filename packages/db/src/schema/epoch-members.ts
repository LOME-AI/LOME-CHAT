import { pgTable, index, integer, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bytea } from './bytea';
import { epochs } from './epochs';

export const epochMembers = pgTable(
  'epoch_members',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    epochId: uuid('epoch_id')
      .notNull()
      .references(() => epochs.id, { onDelete: 'cascade' }),
    memberPublicKey: bytea('member_public_key').notNull(),
    wrap: bytea('wrap').notNull(),
    visibleFromEpoch: integer('visible_from_epoch').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('epoch_members_epoch_key_unique').on(table.epochId, table.memberPublicKey),
    index('epoch_members_public_key_idx').on(table.memberPublicKey),
  ]
);
