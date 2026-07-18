import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, publicStatsSnapshots, usageRecords } from '@hushbox/db';
import { PUBLIC_USAGE_STATS_SCHEMA_VERSION, publicUsageStatsSchema } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { createPublicStatsStores } from '../adapters/public-stats-stores.js';
import {
  buildPublicUsageStats,
  readLatestPublicStatsSnapshot,
  savePublicStatsSnapshot,
} from './public-usage-stats.js';
import type { Modality } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { PublicStatsModelMeta } from './public-usage-stats.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for public-usage-stats integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createPublicStatsStores();
const createdUsageRecordIds: string[] = [];
const createdSnapshotIds: string[] = [];

// A 1961 era isolates these GLOBAL aggregates (including the unbounded
// all-time window, which is capped only by the injected clock) from every
// other test file's rows — nothing else seeds createdAt before 1971.
const NOW = new Date('1961-06-15T12:00:00.000Z');
const DAY = 86_400_000;

async function seedRecords(
  n: number,
  modelId: string,
  createdAt: Date,
  options: { readonly costNanoUsd: bigint; readonly modality?: Modality }
): Promise<void> {
  const { costNanoUsd, modality = 'text' } = options;
  for (let index = 0; index < n; index += 1) {
    const rows = await db
      .insert(usageRecords)
      .values({
        userId: null,
        contentItemId: null,
        runId: crypto.randomUUID(),
        modelId,
        providerName: 'test-provider',
        modality,
        costNanoUsd,
        isEstimated: index % 2 === 0,
        idempotencyKey: `pubstats-domain:${crypto.randomUUID()}`,
        createdAt,
      })
      .returning({ id: usageRecords.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('usage record seed failed');
    createdUsageRecordIds.push(id);
  }
}

const resolveModelMeta = (
  ids: readonly string[]
): ResultAsync<ReadonlyMap<string, PublicStatsModelMeta>, DomainError> =>
  okAsync(
    new Map(
      ids
        .filter((id) => id === 'e2e/model-a')
        .map((id) => [id, { displayName: 'Model A', provider: 'acme' }])
    )
  );

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

describe('buildPublicUsageStats against the real store', () => {
  it('persists a schema-valid snapshot whose stored jsonb carries no count-like keys', async () => {
    await seedRecords(6, 'e2e/model-a', new Date(NOW.getTime() - 2 * DAY), {
      costNanoUsd: 2_000_000n,
    });
    await seedRecords(2, 'e2e/model-b', new Date(NOW.getTime() - 2 * DAY), {
      costNanoUsd: 1_000_000n,
    });
    await seedRecords(3, 'e2e/model-img', new Date(NOW.getTime() - 2 * DAY), {
      costNanoUsd: 5_000_000n,
      modality: 'image',
    });

    const stats = await unwrap(buildPublicUsageStats({ db, stores, now: NOW, resolveModelMeta }));
    const saved = await unwrap(savePublicStatsSnapshot(stores, db, stats));
    createdSnapshotIds.push(saved.id);

    // Read the raw persisted jsonb back — the anonymization boundary holds at
    // rest, not just in the returned object.
    const rows = await db
      .select({ stats: publicStatsSnapshots.stats })
      .from(publicStatsSnapshots)
      .where(eq(publicStatsSnapshots.id, saved.id));
    const persisted: unknown = rows[0]?.stats;
    expect(publicUsageStatsSchema.safeParse(persisted).success).toBe(true);

    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
      } else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(persisted);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => /count|message|token|record|user/i.test(k))).toBe(false);

    const parsed = publicUsageStatsSchema.parse(persisted);
    const text7d = parsed.modalities.text?.['7d'];
    expect(text7d?.models.map((m) => [m.modelId, m.displayName, m.sharePercent])).toEqual([
      ['e2e/model-a', 'Model A', 75],
      ['e2e/model-b', 'e2e/model-b', 25],
    ]);
    expect(Object.keys(parsed.modalities).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'image',
      'text',
    ]);
  });

  it('reads back the latest snapshot for the current schema version', async () => {
    const stats = await unwrap(buildPublicUsageStats({ db, stores, now: NOW, resolveModelMeta }));
    // The cron path is at-least-once — a duplicate insert is harmless and the
    // read resolves to the newest row.
    const first = await unwrap(savePublicStatsSnapshot(stores, db, stats));
    const second = await unwrap(savePublicStatsSnapshot(stores, db, stats));
    createdSnapshotIds.push(first.id, second.id);

    const latest = await unwrap(
      readLatestPublicStatsSnapshot(stores, db, PUBLIC_USAGE_STATS_SCHEMA_VERSION)
    );
    expect(latest?.id).toBe(second.id);
  });
});
