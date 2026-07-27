import { pgTable, jsonb, text, timestamp, unique, uuid, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { modelExcludeReasonEnum } from './enums';

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
    // Admin kill switch (`model.disable`). ASSERTED by a person, and what
    // protects it is that no refresh write names this column in any set clause —
    // not that the refresh writes few columns (it writes `descriptor`,
    // `popularity_rank`, `excluded_reason`, `excluded_at` and `last_seen_at`).
    // That omission is the whole reason the derived `excluded_reason` below is a
    // separate column.
    adminDisabledAt: timestamp('admin_disabled_at', { withTimezone: true }),
    // OpenRouter top-weekly usage rank, 0-based (lower = more used); nullable
    // because media models and any model absent from the /models ranking have
    // none; refreshed each catalog refresh; kept out of the descriptor jsonb so
    // volatile ordering data doesn't churn the content-hashed snapshot.
    popularityRank: integer('popularity_rank'),
    // The three lifecycle columns below carry NO index, deliberately: this table
    // holds one row per model, and its row count is in the low hundreds.
    //
    // Catalog admission's soft delete (BILLING.md §Catalog Admission 4): a row
    // that becomes inadmissible is marked, never deleted, because usage and
    // completion rows reference the model that ran. DERIVED — the hourly
    // refresh recomputes it, so a model whose price later clears the floor
    // returns with no human action. Deliberately NOT the same column as
    // `admin_disabled_at`, which is ASSERTED by a person: one column would
    // force the refresh either to overwrite a human's decision or to trap a
    // model out permanently. Exposure filters on both being null.
    excludedReason: modelExcludeReasonEnum('excluded_reason'),
    // When the row first became inadmissible; preserved across repeat
    // refreshes (mirrors `admin_disabled_at` — the first moment is the
    // audit-relevant fact) and cleared with the reason.
    excludedAt: timestamp('excluded_at', { withTimezone: true }),
    // Advanced for every model present in a live gateway fetch, so a model
    // that has vanished from OpenRouter is detectable by staleness. Acting on
    // staleness is a separate concern; this column is what makes it possible.
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique('model_catalog_model_id_unique').on(table.modelId)]
);
