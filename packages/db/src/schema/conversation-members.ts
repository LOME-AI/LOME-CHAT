import {
  pgTable,
  boolean,
  check,
  index,
  integer,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { isNotNull, isNull, sql } from 'drizzle-orm';

import { conversations } from './conversations';
import { memberPrivilegeEnum } from './enums';
import { sharedLinks } from './shared-links';
import { users } from './users';

export const conversationMembers = pgTable(
  'conversation_members',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    linkId: uuid('link_id').references(() => sharedLinks.id, { onDelete: 'set null' }),
    privilege: memberPrivilegeEnum('privilege').notNull().default('write'),
    visibleFromEpoch: integer('visible_from_epoch').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    muted: boolean('muted').notNull().default(false),
    pinned: boolean('pinned').notNull().default(false),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    uniqueIndex('conversation_members_user_active')
      .on(table.conversationId, table.userId)
      .where(isNull(table.leftAt)),
    uniqueIndex('conversation_members_link_active')
      .on(table.conversationId, table.linkId)
      .where(isNull(table.leftAt)),
    // Full (not active-only) FK indexes: cascades and SET NULL scans hit
    // left rows too
    index('conversation_members_conversation_id_idx').on(table.conversationId),
    index('conversation_members_user_id_idx').on(table.userId),
    index('conversation_members_link_id_idx').on(table.linkId).where(isNotNull(table.linkId)),
    index('conversation_members_invited_by_user_id_idx')
      .on(table.invitedByUserId)
      .where(isNotNull(table.invitedByUserId)),
    check(
      'conversation_members_identity_or_left_check',
      sql`${table.userId} IS NOT NULL OR ${table.linkId} IS NOT NULL OR ${table.leftAt} IS NOT NULL`
    ),
  ]
);
