import { modelCatalog, modelOverrides, modelPricing } from '@hushbox/db';
import { ModelDescriptor } from '@hushbox/shared';
import { unavailableError } from '../../../lib/errors/index.js';
import { idempotent } from '../../../lib/idempotency/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import { ModelOverrideData } from './overrides.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Idempotent } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ModelOverride } from './overrides.js';
import type { DescriptorContent } from './normalize.js';

/**
 * Single-writer persistence for the models slice's tables
 * (model_catalog / model_pricing / model_overrides). Domain code holds the
 * queries directly — Db is deliberately unwrapped (ARCHITECTURE.md ports
 * list) — but never imports drizzle-orm itself: the catalog is a
 * small-by-design full-list table, so reads are whole-table selects folded
 * in memory and writes are conflict-arbitrated inserts, none of which need
 * query operators.
 */

export interface StoredDescriptorRow {
  readonly catalogId: string;
  readonly version: number;
  /** The persisted wire-form descriptor jsonb, unvalidated at this layer. */
  readonly descriptor: unknown;
}

export interface InsertCatalogVersionParams {
  readonly modelId: string;
  readonly version: number;
  readonly content: DescriptorContent;
  readonly fetchedAt: Date;
}

/**
 * Inserts one new catalog version plus its pricing row in one transaction.
 * The UNIQUE(model_id, version) constraint is the idempotency guard
 * (`idempotent.byUpsert`): the losing writer of a duplicate or racing
 * delivery inserts nothing — including the dependent pricing row — and the
 * transaction keeps the pair atomic. Returns whether this caller's insert
 * won.
 */
export function insertCatalogVersion(
  db: Database,
  params: InsertCatalogVersionParams
): ResultAsync<Idempotent<boolean>, DomainError> {
  const descriptor = ModelDescriptor.parse({
    ...params.content,
    version: String(params.version),
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
      db.transaction(async (tx) => {
        const inserted = await tx
          .insert(modelCatalog)
          .values({ modelId: params.modelId, version: params.version, descriptor: wireDescriptor })
          .onConflictDoNothing({ target: [modelCatalog.modelId, modelCatalog.version] })
          .returning({ id: modelCatalog.id });
        const row = inserted[0];
        if (row === undefined) return false;
        await tx.insert(modelPricing).values({
          modelCatalogId: row.id,
          pricing: params.content.pricing,
        });
        return true;
      }),
      (cause) => unavailableError('model catalog version insert failed', cause)
    )
  );
}

/** Latest stored version per model id, folded from a whole-table read. */
export function readLatestDescriptorRows(
  db: Database
): ResultAsync<Map<string, StoredDescriptorRow>, DomainError> {
  return fromPromise(db.select().from(modelCatalog), (cause) =>
    unavailableError('model catalog read failed', cause)
  ).map((rows) => {
    const latest = new Map<string, StoredDescriptorRow>();
    for (const row of rows) {
      const current = latest.get(row.modelId);
      if (current === undefined || row.version > current.version) {
        latest.set(row.modelId, {
          catalogId: row.id,
          version: row.version,
          descriptor: row.descriptor,
        });
      }
    }
    return latest;
  });
}

export interface OverridesRead {
  readonly overrides: Map<string, ModelOverride>;
  /** Rows whose jsonb breaks the contract — omitted from the map (the
   * affected model loses its supplement and stays hidden: fail-closed);
   * callers alert on these instead of crashing the whole catalog. */
  readonly invalidModelIds: readonly string[];
}

export function readOverrides(db: Database): ResultAsync<OverridesRead, DomainError> {
  return fromPromise(db.select().from(modelOverrides), (cause) =>
    unavailableError('model overrides read failed', cause)
  ).map((rows) => {
    const overrides = new Map<string, ModelOverride>();
    const invalidModelIds: string[] = [];
    for (const row of rows) {
      const parsed = ModelOverrideData.safeParse(row.overrides);
      if (parsed.success) {
        overrides.set(row.modelId, {
          modelId: row.modelId,
          data: parsed.data,
          zdrVerifiedAt: row.zdrVerifiedAt,
        });
      } else {
        invalidModelIds.push(row.modelId);
      }
    }
    return { overrides, invalidModelIds };
  });
}
