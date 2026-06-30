import { pgTable, index, jsonb, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { modelCatalog } from './model-catalog';

export const modelPricing = pgTable(
  'model_pricing',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    modelCatalogId: uuid('model_catalog_id')
      .notNull()
      .references(() => modelCatalog.id, { onDelete: 'cascade' }),
    // Pricing matrices (per-token rates, per-size image grids)
    pricing: jsonb('pricing').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('model_pricing_model_catalog_id_idx').on(table.modelCatalogId)]
);
