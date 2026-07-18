import { buildPublicUsageStats, savePublicStatsSnapshot } from '../slices/billing/index.js';
import { listDescriptors } from '../slices/models/index.js';
import { runOrThrow } from './cron.js';
import type { Database } from '@hushbox/db';
import type { ModelDescriptor } from '@hushbox/shared';
import type {
  BuildPublicUsageStatsDeps,
  PublicStatsModelMeta,
  PublicStatsStores,
} from '../slices/billing/index.js';
import type { ListDescriptorsDeps } from '../slices/models/index.js';
import type { CronEntry } from './cron.js';

/**
 * The daily public usage-stats snapshot: the billing slice builds the
 * anonymized payload and appends one snapshot row. At-least-once duplicates
 * are harmless by design — the endpoint reads only the latest row — so the
 * entry carries no dedup.
 */

/** The displayed-id subset of the exposed catalog, name falling back to the raw id. */
export function modelMetaFromDescriptors(
  descriptors: readonly ModelDescriptor[],
  modelIds: readonly string[]
): ReadonlyMap<string, PublicStatsModelMeta> {
  const wanted = new Set(modelIds);
  const meta = new Map<string, PublicStatsModelMeta>();
  for (const descriptor of descriptors) {
    if (!wanted.has(descriptor.id)) continue;
    meta.set(descriptor.id, {
      displayName: descriptor.name ?? descriptor.id,
      provider: descriptor.provider,
    });
  }
  return meta;
}

/**
 * Bridges the models slice's published catalog read into billing's meta
 * seam — model_catalog is models-owned, so billing never queries it. Hidden
 * or since-removed models simply miss the map and render as raw ids.
 */
export function createCatalogModelMetaResolver(
  deps: ListDescriptorsDeps
): BuildPublicUsageStatsDeps['resolveModelMeta'] {
  return (modelIds) =>
    listDescriptors(deps).map((descriptors) => modelMetaFromDescriptors(descriptors, modelIds));
}

export interface PublicStatsSnapshotEntryDeps {
  readonly db: Database;
  readonly stores: PublicStatsStores;
  readonly now: () => Date;
  readonly resolveModelMeta: BuildPublicUsageStatsDeps['resolveModelMeta'];
}

export function createPublicStatsSnapshotEntry(deps: PublicStatsSnapshotEntryDeps): CronEntry {
  return {
    name: 'public-stats-snapshot',
    run: async (): Promise<void> => {
      const stats = await runOrThrow(
        buildPublicUsageStats({
          db: deps.db,
          stores: deps.stores,
          now: deps.now(),
          resolveModelMeta: deps.resolveModelMeta,
        })
      );
      await runOrThrow(savePublicStatsSnapshot(deps.stores, deps.db, stats));
    },
  };
}
