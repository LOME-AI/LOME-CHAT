import { pgTable, integer, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Persisted capability catalog. Surrogate uuid PK + UNIQUE(modelId,
 * version) — single-column FKs everywhere pin the metadata in effect by
 * construction.
 */
export const modelCatalog = pgTable(
  'model_catalog',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    modelId: text('model_id').notNull(),
    version: integer('version').notNull(),
    // The shared ModelDescriptor contract, Zod-validated at the models slice
    descriptor: jsonb('descriptor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique('model_catalog_model_version_unique').on(table.modelId, table.version)]
);
