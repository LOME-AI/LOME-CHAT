import { pgTable, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Manual supplements for capability gaps the gateway can't express
 * (ParamSpecs, pricing matrices, ZDR verification). Keyed by the gateway
 * model id, deliberately not an FK to model_catalog: overrides apply across
 * every catalog version of a model and may pre-exist its first discovery.
 */
export const modelOverrides = pgTable('model_overrides', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  modelId: text('model_id').notNull().unique(),
  overrides: jsonb('overrides').notNull(),
  // Dated ZDR verification (aged data alerts past 90 days)
  zdrVerifiedAt: timestamp('zdr_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
