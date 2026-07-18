import { pgTable, jsonb, text, timestamp, unique, uuid, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Persisted capability catalog: one row per model, a durable, joinable,
 * cron-refreshed snapshot of OpenRouter metadata. The surrogate uuid PK is
 * kept because billing rows FK into it; UNIQUE(model_id) makes the upsert
 * key a single column. Authoritative cost is inline on each usage row, so
 * there is no historical-pricing recompute and therefore no versioning.
 */
export const modelCatalog = pgTable(
  'model_catalog',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    modelId: text('model_id').notNull(),
    // The shared ModelDescriptor contract, Zod-validated at the models slice
    descriptor: jsonb('descriptor').notNull(),
    // Admin kill switch (`model.disable`); the catalog refresh upsert
    // touches only `descriptor`, so this flag survives refresh.
    adminDisabledAt: timestamp('admin_disabled_at', { withTimezone: true }),
    // OpenRouter top-weekly usage rank, 0-based (lower = more used); nullable
    // because media models and any model absent from the /models ranking have
    // none; refreshed each catalog refresh; kept out of the descriptor jsonb so
    // volatile ordering data doesn't churn the content-hashed snapshot.
    popularityRank: integer('popularity_rank'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique('model_catalog_model_id_unique').on(table.modelId)]
);
