import { pgTable, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Append-only admin audit (actions AND reads), written by the product
 * Worker. `actor` is the Cloudflare Access identity — no users FK, admins
 * are not product users; `target` is polymorphic by design, so no FK either.
 */
export const adminAudit = pgTable('admin_audit', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: uuid('target_id'),
  details: jsonb('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
