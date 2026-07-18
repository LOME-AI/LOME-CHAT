import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, publicStatsSnapshots, usageRecords } from '@hushbox/db';
import { PUBLIC_USAGE_STATS_SCHEMA_VERSION } from '@hushbox/shared';
import { createPublicStatsStores } from './public-stats-stores.js';
import type { Modality, PublicUsageStats } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for public-stats store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createPublicStatsStores();
const createdUsageRecordIds: string[] = [];
const createdSnapshotIds: string[] = [];

// All seeds live in a far-past window so the GLOBAL (unscoped) aggregates
// never see rows other test files write concurrently, and vice versa.
const DAY = 86_400_000;
const BASE = Date.parse('1987-03-10T12:00:00.000Z');

async function seedRecord(args: {
  readonly modelId: string;
  readonly modality?: Modality;
  readonly costNanoUsd: bigint;
  readonly createdAt: Date;
}): Promise<void> {
  const rows = await db
    .insert(usageRecords)
    .values({
      userId: null,
      contentItemId: null,
      runId: crypto.randomUUID(),
      modelId: args.modelId,
      providerName: 'test-provider',
      modality: args.modality ?? 'text',
      costNanoUsd: args.costNanoUsd,
      isEstimated: false,
      idempotencyKey: `pubstats:${crypto.randomUUID()}`,
      createdAt: args.createdAt,
    })
    .returning({ id: usageRecords.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('usage record seed failed');
  createdUsageRecordIds.push(id);
}

function minimalStats(generatedAt: string): PublicUsageStats {
  return {
    schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
    generatedAt,
    modalities: {},
  };
}

async function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

afterAll(async () => {
  if (createdUsageRecordIds.length > 0) {
    await db.delete(usageRecords).where(inArray(usageRecords.id, createdUsageRecordIds));
  }
  if (createdSnapshotIds.length > 0) {
    await db
      .delete(publicStatsSnapshots)
      .where(inArray(publicStatsSnapshots.id, createdSnapshotIds));
  }
});

describe('aggregateGlobalUsageByModel', () => {
  it('groups by model across all users with bigint cost sums', async () => {
    const at = new Date(BASE);
    await seedRecord({ modelId: 'agg/model-a', costNanoUsd: 5_000_000n, createdAt: at });
    await seedRecord({ modelId: 'agg/model-a', costNanoUsd: 7_000_000n, createdAt: at });
    await seedRecord({ modelId: 'agg/model-b', costNanoUsd: 1_000_000n, createdAt: at });

    const result = await stores.aggregateGlobalUsageByModel(db, {
      modality: 'text',
      start: new Date(BASE - DAY),
      end: new Date(BASE + DAY),
    });
    const rows = result._unsafeUnwrap();
    const a = rows.find((r) => r.modelId === 'agg/model-a');
    const b = rows.find((r) => r.modelId === 'agg/model-b');
    expect(a).toEqual({ modelId: 'agg/model-a', messageCount: 2, costNanoUsd: 12_000_000n });
    expect(b).toEqual({ modelId: 'agg/model-b', messageCount: 1, costNanoUsd: 1_000_000n });
  });

  it('applies the half-open [start, end) createdAt window', async () => {
    const start = new Date(BASE + 10 * DAY);
    const end = new Date(BASE + 11 * DAY);
    await seedRecord({
      modelId: 'win/model',
      costNanoUsd: 1n,
      createdAt: new Date(start.getTime() - 1),
    });
    await seedRecord({ modelId: 'win/model', costNanoUsd: 2n, createdAt: start });
    await seedRecord({
      modelId: 'win/model',
      costNanoUsd: 4n,
      createdAt: new Date(end.getTime() - 1),
    });
    await seedRecord({ modelId: 'win/model', costNanoUsd: 8n, createdAt: end });

    const rows = await unwrap(
      stores.aggregateGlobalUsageByModel(db, { modality: 'text', start, end })
    );
    expect(rows).toEqual([{ modelId: 'win/model', messageCount: 2, costNanoUsd: 6n }]);
  });

  it('filters by modality', async () => {
    const at = new Date(BASE + 20 * DAY);
    await seedRecord({ modelId: 'mod/model', modality: 'image', costNanoUsd: 3n, createdAt: at });
    await seedRecord({ modelId: 'mod/model', modality: 'text', costNanoUsd: 9n, createdAt: at });

    const rows = await unwrap(
      stores.aggregateGlobalUsageByModel(db, {
        modality: 'image',
        start: new Date(at.getTime() - 1),
        end: new Date(at.getTime() + 1),
      })
    );
    expect(rows).toEqual([{ modelId: 'mod/model', messageCount: 1, costNanoUsd: 3n }]);
  });

  it('treats a null start as all-time (unbounded below)', async () => {
    // 1971 predates every other seed's window, so only the end bound applies.
    const ancient = new Date('1971-01-01T00:00:00.000Z');
    await seedRecord({ modelId: 'alltime/model', costNanoUsd: 2n, createdAt: ancient });

    const rows = await unwrap(
      stores.aggregateGlobalUsageByModel(db, {
        modality: 'text',
        start: null,
        end: new Date('1971-01-02T00:00:00.000Z'),
      })
    );
    expect(rows).toContainEqual({ modelId: 'alltime/model', messageCount: 1, costNanoUsd: 2n });
  });
});

describe('readGlobalCostPercentiles', () => {
  it('computes interpolated median and p90 over per-record costs', async () => {
    const at = new Date(BASE + 30 * DAY);
    for (const cost of [100n, 200n, 300n, 400n, 1000n]) {
      await seedRecord({ modelId: 'pct/model', costNanoUsd: cost, createdAt: at });
    }
    const pct = await unwrap(
      stores.readGlobalCostPercentiles(db, {
        modality: 'text',
        start: new Date(at.getTime() - 1),
        end: new Date(at.getTime() + 1),
      })
    );
    // percentile_cont interpolates: p90 over [100..1000] = 400 + 0.6*(1000-400).
    expect(pct).toEqual({ medianNanoUsd: 300, p90NanoUsd: 760 });
  });

  it('returns null for a window with no records', async () => {
    const pct = await unwrap(
      stores.readGlobalCostPercentiles(db, {
        modality: 'text',
        start: new Date('1972-01-01T00:00:00.000Z'),
        end: new Date('1972-01-02T00:00:00.000Z'),
      })
    );
    expect(pct).toBeNull();
  });
});

describe('readGlobalTrendCounts', () => {
  it('groups counts per UTC day bucket and model', async () => {
    const day1 = new Date(BASE + 40 * DAY);
    const day2 = new Date(BASE + 41 * DAY);
    await seedRecord({ modelId: 'trend/model', costNanoUsd: 1n, createdAt: day1 });
    await seedRecord({ modelId: 'trend/model', costNanoUsd: 1n, createdAt: day1 });
    await seedRecord({ modelId: 'trend/model', costNanoUsd: 1n, createdAt: day2 });

    const rows = await unwrap(
      stores.readGlobalTrendCounts(db, {
        modality: 'text',
        start: new Date(day1.getTime() - 1),
        end: new Date(day2.getTime() + 1),
        bucket: 'day',
      })
    );
    expect([...rows].toSorted((a, b) => a.bucketStart.localeCompare(b.bucketStart))).toEqual([
      { bucketStart: day1.toISOString().slice(0, 10), modelId: 'trend/model', messageCount: 2 },
      { bucketStart: day2.toISOString().slice(0, 10), modelId: 'trend/model', messageCount: 1 },
    ]);
  });

  it('groups by month start when bucketed monthly', async () => {
    const at = new Date('1988-07-19T05:00:00.000Z');
    await seedRecord({ modelId: 'trendm/model', costNanoUsd: 1n, createdAt: at });

    const rows = await unwrap(
      stores.readGlobalTrendCounts(db, {
        modality: 'text',
        start: new Date('1988-07-01T00:00:00.000Z'),
        end: new Date('1988-08-01T00:00:00.000Z'),
        bucket: 'month',
      })
    );
    expect(rows).toEqual([{ bucketStart: '1988-07-01', modelId: 'trendm/model', messageCount: 1 }]);
  });
});

describe('snapshot store', () => {
  // A unique version per run isolates these global-table reads from prior runs.
  const version = 1_000_000 + Math.floor(Math.random() * 1_000_000);

  it('inserts a snapshot row and returns it', async () => {
    const stats = minimalStats('2026-01-01T00:00:00.000Z');
    const row = await unwrap(
      stores.insertPublicStatsSnapshot(db, { schemaVersion: version + 1, stats })
    );
    createdSnapshotIds.push(row.id);
    expect(row.schemaVersion).toBe(version + 1);
    expect(row.stats).toEqual(stats);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('reads the latest row matching the schema version', async () => {
    const first = await unwrap(
      stores.insertPublicStatsSnapshot(db, {
        schemaVersion: version,
        stats: minimalStats('2026-01-01T00:00:00.000Z'),
      })
    );
    const second = await unwrap(
      stores.insertPublicStatsSnapshot(db, {
        schemaVersion: version,
        stats: minimalStats('2026-01-02T00:00:00.000Z'),
      })
    );
    createdSnapshotIds.push(first.id, second.id);

    const latest = await unwrap(stores.readLatestPublicStatsSnapshot(db, version));
    expect(latest?.id).toBe(second.id);
  });

  it('returns null when no snapshot matches the schema version', async () => {
    const latest = await unwrap(stores.readLatestPublicStatsSnapshot(db, version + 2));
    expect(latest).toBeNull();
  });
});
