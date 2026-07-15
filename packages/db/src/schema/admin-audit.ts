import { pgTable, index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Append-only admin audit (actions AND reads), written by the product
 * Worker. `actor` is the Cloudflare Access identity — no users FK, admins
 * are not product users; `target` is polymorphic by design, so no FK either.
 * Append-only is trigger-enforced (UPDATE/DELETE raise — hand-written SQL in
 * the migration; drizzle-kit does not model triggers).
 */
export const adminAudit = pgTable(
  'admin_audit',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    // Text, not uuid: model ops target string model ids (e.g. `openai/gpt-5`)
    // and audit search needs one uniform indexed target path; uuid targets
    // stringify losslessly.
    targetId: text('target_id'),
    details: jsonb('details'),
    // Set only on undo actions: the audit row of the op being undone. The
    // UNIQUE claim makes undo exactly-once — two concurrent undos of the
    // same row cannot both commit.
    undoes: uuid('undoes')
      .unique()
      .references((): AnyPgColumn => adminAudit.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('admin_audit_target_idx').on(table.targetType, table.targetId),
    index('admin_audit_actor_created_at_idx').on(table.actor, table.createdAt),
  ]
);
