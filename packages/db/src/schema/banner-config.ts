import { pgTable, jsonb, timestamp, uuid, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * The single active announcement-banner configuration. Single writer is the
 * announcements slice: its published `setWithinTx` is the write path, composed
 * by the admin plane's `banner.set` operation (so messages change with no
 * deploy, and never by direct SQL).
 *
 * `messages` stays an untrusted jsonb array salvaged by `bannerConfigSchema` at
 * read time (each message carries its own severity variant, salvaged to `info`);
 * `enabled` defaults false so a half-filled row stays dark. The slice reads
 * the newest row, so a stray duplicate is deterministic rather than ambiguous.
 */
export const bannerConfig = pgTable('banner_config', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  enabled: boolean('enabled').notNull().default(false),
  messages: jsonb('messages')
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
