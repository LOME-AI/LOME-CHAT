import { pgTable, index, integer, jsonb, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// One row per daily cron run holding the full public payload as jsonb. The
// payload is already anonymized at write time — percent shares and cost strings
// only, never counts — so this table stores nothing sensitive. Written only by
// the billing slice (single-writer); self-contained by design, so no FKs. Rows
// are retained forever — there is deliberately no pruning or retention job. The
// endpoint reads the latest row matching the current schema_version.
export const publicStatsSnapshots = pgTable(
  'public_stats_snapshots',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    schemaVersion: integer('schema_version').notNull(),
    stats: jsonb('stats').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('public_stats_snapshots_created_at_idx').on(table.createdAt)]
);
