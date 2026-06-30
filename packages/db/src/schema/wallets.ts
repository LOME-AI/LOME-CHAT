import { pgTable, bigint, index, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { walletTypeEnum } from './enums';
import { users } from './users';

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    // SET NULL: financial rows survive hard user deletion, pseudonymized
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    type: walletTypeEnum('type').notNull(),
    balanceNanoUsd: bigint('balance_nano_usd', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('wallets_user_id_idx').on(table.userId),
    unique('wallets_user_type_unique').on(table.userId, table.type),
  ]
);
