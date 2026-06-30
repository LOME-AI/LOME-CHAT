import { pgTable, jsonb, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { users } from './users';

/**
 * Accessibility preferences — an LWW-synced jsonb blob,
 * Zod-validated at the API boundary (the account slice owns the contract).
 */
export const preferences = pgTable('preferences', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessibility: jsonb('accessibility')
    .notNull()
    .default(sql`'{"version":1}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
