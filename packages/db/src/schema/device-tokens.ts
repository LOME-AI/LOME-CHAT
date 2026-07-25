import { pgTable, check, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { devicePlatformEnum } from './enums';
import { users } from './users';

/**
 * One row per push subscription. For `web` rows `token` holds the Web Push
 * endpoint URL and `p256dh`/`auth` carry the subscription's encryption keys;
 * for `ios`/`android` rows `token` is the FCM/APNs device token and the key
 * columns stay null. The CHECK binds key presence to the `web` platform in
 * both directions so no half-populated subscription can persist.
 */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    platform: devicePlatformEnum('platform').notNull(),
    p256dh: text('p256dh'),
    auth: text('auth'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('device_tokens_user_id_idx').on(table.userId),
    check(
      'device_tokens_web_keys_present',
      // `platform::text = 'web'` (cast), never a bare enum-literal comparison: this
      // CHECK and the `device_platform ADD VALUE 'web'` land in the same migration, and
      // Postgres forbids using a freshly-added enum value in the same transaction that
      // added it — the cast to text avoids that hazard on an incremental deploy.
      sql`(${table.platform}::text = 'web') = (${table.p256dh} IS NOT NULL) AND (${table.platform}::text = 'web') = (${table.auth} IS NOT NULL)`
    ),
  ]
);
