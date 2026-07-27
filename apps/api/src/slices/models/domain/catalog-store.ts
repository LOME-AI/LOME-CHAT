import { modelCatalog } from '@hushbox/db';
import { ModelDescriptor } from '@hushbox/shared';
import { unavailableError } from '../../../lib/errors/index.js';
import { idempotent } from '../../../lib/idempotency/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { ExcludeReason } from '@hushbox/shared';
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
  /**
   * The admin kill switch (`model.disable`): non-null hides the model from
   * every exposure surface and refuses it at turn-time resolution. The
   * refresh upsert's set clause never touches this column, so the flag
   * survives refresh.
   */
  readonly adminDisabledAt: Date | null;
  /**
   * Catalog admission's soft delete (BILLING.md §Catalog Admission 4): non-null
   * means the model is no longer sellable and every exposure surface hides it.
   * DERIVED — recomputed by each refresh — which is why it is a separate
   * authority from the asserted `adminDisabledAt`.
   */
  readonly excludedReason: ExcludeReason | null;
  /** OpenRouter top-weekly usage rank, 0-based (lower = more used); `null` when
   * the model is unranked (media, or absent from the sorted `/models` set).
   * Lives only in this column — never in the descriptor jsonb — and is injected
   * onto the descriptor at read time. */
  readonly popularityRank: number | null;
}

export interface UpsertCatalogParams {
  readonly modelId: string;
  readonly content: DescriptorContent;
  readonly fetchedAt: Date;
  /** Top-weekly usage rank for the column; `null` for unranked models. */
  readonly popularityRank: number | null;
}

/**
 * Upserts one model's descriptor, keyed by `model_id` (UNIQUE). The refresh
 * only calls this when the content changed, so the conflict path overwrites
 * the stale row in place — there is no versioning. Idempotent by the unique
 * constraint: a racing writer overwrites with identical content, so the row
 * converges either way.
 *
 * Writing a descriptor is by definition an admission, so this clears the soft
 * delete (BILLING.md §Catalog Admission 4) — that is one of the two halves that
 * make a model's return automatic. `adminDisabledAt` is never in the set clause:
 * a human's decision survives every refresh.
 */
export function upsertCatalog(
  db: Database,
  params: UpsertCatalogParams
): ResultAsync<Idempotent<unknown>, DomainError> {
  // `version` rides in the content itself (stamped by normalize — '2' =
  // billable rates), so a version bump changes the content hash and rewrites
  // every row on the next refresh.
  const descriptor = ModelDescriptor.parse({
    ...params.content,
    fetchedAt: params.fetchedAt.getTime(),
  });
  // Persist the wire form (NanoUSD strings) — the parse above only asserts
  // the contract; branded bigints are not JSON.
  const wireDescriptor = {
    ...params.content,
    fetchedAt: descriptor.fetchedAt,
  };
  return idempotent.byUpsert(() =>
    fromPromise(
      db
        .insert(modelCatalog)
        .values({
          modelId: params.modelId,
          descriptor: wireDescriptor,
          popularityRank: params.popularityRank,
          excludedReason: null,
          excludedAt: null,
          lastSeenAt: params.fetchedAt,
        })
        .onConflictDoUpdate({
          target: modelCatalog.modelId,
          set: {
            descriptor: wireDescriptor,
            popularityRank: params.popularityRank,
            excludedReason: null,
            excludedAt: null,
            lastSeenAt: params.fetchedAt,
          },
        }),
      (cause) => unavailableError('model catalog upsert failed', cause)
    )
  );
}

/**
 * The stored descriptor per model id, folded from a whole-table read, in
 * `model_id` order.
 *
 * The order is part of the contract, not a convenience: every exposure surface
 * derives its catalog list from this map's insertion order, and a plain select has
 * no defined row order at all. What this guarantees is that the same table yields
 * the same list twice — which is what lets a pool be reproducible from the catalog
 * (BILLING.md §Smart Model 1) instead of from whatever order Postgres returned.
 */
export function readLatestDescriptorRows(
  db: Database
): ResultAsync<Map<string, StoredDescriptorRow>, DomainError> {
  return fromPromise(db.select().from(modelCatalog), (cause) =>
    unavailableError('model catalog read failed', cause)
  ).map((rows) => {
    const byModel = new Map<string, StoredDescriptorRow>();
    // Sorted in memory rather than by the query: this is already a whole-table
    // read folded in memory, and keeping the ordering here means no caller has to
    // know the read is ordered by anything but the identifier.
    for (const row of rows.toSorted((left, right) => (left.modelId < right.modelId ? -1 : 1))) {
      byModel.set(row.modelId, {
        catalogId: row.id,
        descriptor: row.descriptor,
        adminDisabledAt: row.adminDisabledAt,
        excludedReason: row.excludedReason,
        popularityRank: row.popularityRank,
      });
    }
    return byModel;
  });
}
