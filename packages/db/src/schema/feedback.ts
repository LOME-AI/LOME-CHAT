import { pgTable, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { feedbackKindEnum, feedbackStatusEnum } from './enums';
import { users } from './users';

export const feedback = pgTable(
  'feedback',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: feedbackKindEnum('kind').notNull(),
    status: feedbackStatusEnum('status').notNull().default('new'),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('feedback_user_id_idx').on(table.userId),
    index('feedback_status_created_at_idx').on(table.status, table.createdAt),
  ]
);
