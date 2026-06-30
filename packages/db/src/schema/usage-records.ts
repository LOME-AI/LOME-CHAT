import { pgTable, bigint, boolean, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { isNotNull, sql } from 'drizzle-orm';

import { contentItems } from './content-items';
import { modalityEnum } from './enums';
import { modelCatalog } from './model-catalog';
import { users } from './users';

/**
 * Saved ⟺ billed is referential at insert — every row is inserted with a
 * non-null contentItemId inside settle(); the column stays nullable with
 * ON DELETE SET NULL so financial retention survives hard deletion.
 */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    contentItemId: uuid('content_item_id').references(() => contentItems.id, {
      onDelete: 'set null',
    }),
    // Plain grouping uuid — there is no run table
    runId: uuid('run_id').notNull(),
    modelCatalogId: uuid('model_catalog_id')
      .notNull()
      .references(() => modelCatalog.id, { onDelete: 'restrict' }),
    // The monthly invoice auditor reconciles Σ cost per modality
    modality: modalityEnum('modality').notNull(),
    // Gateway generation id keying the per-generation true-up
    generationId: text('generation_id'),
    costNanoUsd: bigint('cost_nano_usd', { mode: 'bigint' }).notNull(),
    isEstimated: boolean('is_estimated').notNull().default(false),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('usage_records_user_id_idx').on(table.userId).where(isNotNull(table.userId)),
    index('usage_records_content_item_id_idx')
      .on(table.contentItemId)
      .where(isNotNull(table.contentItemId)),
    index('usage_records_model_catalog_id_idx').on(table.modelCatalogId),
    index('usage_records_run_id_idx').on(table.runId),
  ]
);
