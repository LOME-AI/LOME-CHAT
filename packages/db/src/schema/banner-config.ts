import { pgTable, jsonb, timestamp, uuid, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { bannerVariantEnum } from './enums';

/**
 * The single active announcement-banner configuration. Operator-edited
 * out-of-band by direct SQL — the announcements slice reads it live but never
 * writes it (so messages change with no deploy).
 *
 * `messages` is an untrusted jsonb array salvaged by `bannerConfigSchema` at read
 * time; `enabled` defaults false so a half-filled row stays dark. The slice reads
 * the newest row, so a stray duplicate is deterministic rather than ambiguous.
 */
export const bannerConfig = pgTable('banner_config', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  enabled: boolean('enabled').notNull().default(false),
  variant: bannerVariantEnum('variant').notNull().default('info'),
  messages: jsonb('messages')
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
