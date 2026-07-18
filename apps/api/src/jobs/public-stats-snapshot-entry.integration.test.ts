import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { PUBLIC_USAGE_STATS_SCHEMA_VERSION, nanoUSD } from '@hushbox/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { unavailableError } from '../lib/errors/index.js';
import { errAsync, okAsync } from '../lib/result/index.js';
import {
  createCatalogModelMetaResolver,
  createPublicStatsSnapshotEntry,
  modelMetaFromDescriptors,
} from './public-stats-snapshot-entry.js';
import type { Database } from '@hushbox/db';
import type { ModelDescriptor, PublicUsageStats } from '@hushbox/shared';
import type { Telemetry } from '../lib/telemetry/index.js';
import type { PublicStatsStores } from '../slices/billing/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for public-stats-snapshot-entry integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

afterAll(async () => {
  await db.$client.end();
});

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
};

const NOW = new Date('2026-07-17T03:00:00.000Z');

interface StoresHarness {
  readonly stores: PublicStatsStores;
  readonly inserted: { schemaVersion: number; stats: PublicUsageStats }[];
}

/** Fakes only the port seam; the billing domain builder runs for real. */
function fakeStores(overrides?: Partial<PublicStatsStores>): StoresHarness {
  const inserted: StoresHarness['inserted'] = [];
  const stores: PublicStatsStores = {
    aggregateGlobalUsageByModel: () => okAsync([]),
    readGlobalCostPercentiles: () => okAsync(null),
    readGlobalTrendCounts: () => okAsync([]),
    insertPublicStatsSnapshot: (_db, input) => {
      inserted.push(input);
      return okAsync({
        id: 'snapshot-1',
        schemaVersion: input.schemaVersion,
        stats: input.stats,
        createdAt: NOW,
      });
    },
    readLatestPublicStatsSnapshot: () => okAsync(null),
    ...overrides,
  };
  return { stores, inserted };
}

function entryWith(harness: StoresHarness): ReturnType<typeof createPublicStatsSnapshotEntry> {
  return createPublicStatsSnapshotEntry({
    db: {} as Database,
    stores: harness.stores,
    now: () => NOW,
    resolveModelMeta: () => okAsync(new Map()),
  });
}

function descriptorFixture(overrides: Partial<ModelDescriptor> & { id: string }): ModelDescriptor {
  return {
    provider: overrides.id.split('/')[0] ?? 'prov',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: { input: nanoUSD(1000n) },
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 1_700_000_000,
    ...overrides,
  };
}

describe('createPublicStatsSnapshotEntry', () => {
  it('names the entry public-stats-snapshot', () => {
    expect(entryWith(fakeStores()).name).toBe('public-stats-snapshot');
  });

  it('builds the payload and inserts one snapshot row on success', async () => {
    const harness = fakeStores();
    await expect(entryWith(harness).run()).resolves.toBeUndefined();
    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]?.schemaVersion).toBe(PUBLIC_USAGE_STATS_SCHEMA_VERSION);
    expect(harness.inserted[0]?.stats.generatedAt).toBe(NOW.toISOString());
    expect(harness.inserted[0]?.stats.modalities).toEqual({});
  });

  it('propagates a build failure to the throw channel without inserting', async () => {
    const harness = fakeStores({
      aggregateGlobalUsageByModel: () => errAsync(unavailableError('aggregate query failed')),
    });
    await expect(entryWith(harness).run()).rejects.toThrow('unavailable');
    expect(harness.inserted).toHaveLength(0);
  });

  it('propagates a snapshot insert failure to the throw channel', async () => {
    const harness = fakeStores({
      insertPublicStatsSnapshot: () => errAsync(unavailableError('snapshot insert failed')),
    });
    await expect(entryWith(harness).run()).rejects.toThrow('unavailable');
  });
});

describe('modelMetaFromDescriptors', () => {
  it('maps requested ids to display meta with the raw id as the name fallback', () => {
    const descriptors = [
      descriptorFixture({ id: 'prov/named', name: 'Named Model' }),
      descriptorFixture({ id: 'prov/unnamed' }),
      descriptorFixture({ id: 'prov/unrequested', name: 'Skipped' }),
    ];
    const meta = modelMetaFromDescriptors(descriptors, [
      'prov/named',
      'prov/unnamed',
      'prov/absent',
    ]);
    expect(meta.get('prov/named')).toEqual({ displayName: 'Named Model', provider: 'prov' });
    expect(meta.get('prov/unnamed')).toEqual({ displayName: 'prov/unnamed', provider: 'prov' });
    expect(meta.has('prov/unrequested')).toBe(false);
    expect(meta.has('prov/absent')).toBe(false);
  });
});

describe('createCatalogModelMetaResolver', () => {
  it('reads the live catalog and omits ids the catalog does not expose', async () => {
    const resolver = createCatalogModelMetaResolver({ db, telemetry: silentTelemetry });
    const unknownId = `pss-${crypto.randomUUID()}/absent`;
    const resolved = await resolver([unknownId]);
    expect(resolved._unsafeUnwrap().has(unknownId)).toBe(false);
  });
});
