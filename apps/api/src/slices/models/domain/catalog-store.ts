import { modelCatalog } from '@hushbox/db';
import { ModelDescriptor } from '@hushbox/shared';
import { unavailableError } from '../../../lib/errors/index.js';
import { idempotent } from '../../../lib/idempotency/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Idempotent } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DescriptorContent } from './normalize.js';

/**
 * Single-writer persistence for the models slice's one table
 * (model_catalog). Domain code holds the queries directly — Db is
 * deliberately unwrapped (ARCHITECTURE.md ports list) — but never imports
 * drizzle-orm itself: the catalog is a small-by-design one-row-per-model
 * table, so reads are whole-table selects folded in memory and writes are
 * conflict-arbitrated upserts, none of which need query operators. Pricing
 * lives in the descriptor jsonb: OpenRouter cost is authoritative inline, so
 * there is no separate pricing table to keep in sync.
 */

export interface StoredDescriptorRow {
  readonly catalogId: string;
  /** The persisted wire-form descriptor jsonb, unvalidated at this layer. */
  readonly descriptor: unknown;
}

export interface UpsertCatalogParams {
  readonly modelId: string;
  readonly content: DescriptorContent;
  readonly fetchedAt: Date;
}

/**
 * Upserts one model's descriptor, keyed by `model_id` (UNIQUE). The refresh
 * only calls this when the content changed, so the conflict path overwrites
 * the stale row in place — there is no versioning. Idempotent by the unique
 * constraint: a racing writer overwrites with identical content, so the row
 * converges either way.
 */
export function upsertCatalog(
  db: Database,
  params: UpsertCatalogParams
): ResultAsync<Idempotent<unknown>, DomainError> {
  const descriptor = ModelDescriptor.parse({
    ...params.content,
    // No versioning: one row per model. `version` remains a required
    // descriptor-contract field for shape stability, pinned to '1'.
    version: '1',
    fetchedAt: params.fetchedAt.getTime(),
  });
  // Persist the wire form (NanoUSD strings) — the parse above only asserts
  // the contract; branded bigints are not JSON.
  const wireDescriptor = {
    ...params.content,
    version: descriptor.version,
    fetchedAt: descriptor.fetchedAt,
  };
  return idempotent.byUpsert(() =>
    fromPromise(
      db
        .insert(modelCatalog)
        .values({ modelId: params.modelId, descriptor: wireDescriptor })
        .onConflictDoUpdate({
          target: modelCatalog.modelId,
          set: { descriptor: wireDescriptor },
        }),
      (cause) => unavailableError('model catalog upsert failed', cause)
    )
  );
}

/** The stored descriptor per model id, folded from a whole-table read. */
export function readLatestDescriptorRows(
  db: Database
): ResultAsync<Map<string, StoredDescriptorRow>, DomainError> {
  return fromPromise(db.select().from(modelCatalog), (cause) =>
    unavailableError('model catalog read failed', cause)
  ).map((rows) => {
    const byModel = new Map<string, StoredDescriptorRow>();
    for (const row of rows) {
      byModel.set(row.modelId, { catalogId: row.id, descriptor: row.descriptor });
    }
    return byModel;
  });
}
