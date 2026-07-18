import { describe, expect, it } from 'vitest';
import { createPublicStatsStores } from './public-stats-stores.js';
import type { Database } from '@hushbox/db';
import type { PublicUsageStats } from '@hushbox/shared';

/**
 * Unit coverage for the adapter's defensive branches that a healthy Postgres
 * can never produce (driver rejections, impossible empty result sets). The
 * happy paths run against the real database in the colocated integration
 * tests.
 */

const stores = createPublicStatsStores();

/**
 * A query-builder stub: `outcome` itself (a real promise, so awaiting settles
 * with it) is augmented with builder methods that all return the same object,
 * mimicking Drizzle's chainable, awaitable builders.
 */
function stubDb(outcome: Promise<unknown>): Database {
  const chain = outcome as Promise<unknown> & Record<string, () => unknown>;
  const link = (): unknown => chain;
  return Object.assign(chain, {
    select: link,
    insert: link,
    values: link,
    returning: link,
    from: link,
    where: link,
    groupBy: link,
    orderBy: link,
    limit: link,
  }) as unknown as Database;
}

const WINDOW = {
  modality: 'text',
  start: null,
  end: new Date('2026-01-01T00:00:00.000Z'),
} as const;

describe('createPublicStatsStores defensive branches', () => {
  it('maps a driver rejection to an unavailable error', async () => {
    const result = await stores.aggregateGlobalUsageByModel(
      stubDb(Promise.reject(new Error('connection refused'))),
      WINDOW
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('returns null percentiles when the aggregate row is missing entirely', async () => {
    const result = await stores.readGlobalCostPercentiles(stubDb(Promise.resolve([])), WINDOW);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('returns null percentiles when only p90 is null', async () => {
    const result = await stores.readGlobalCostPercentiles(
      stubDb(Promise.resolve([{ medianNanoUsd: 5, p90NanoUsd: null }])),
      WINDOW
    );
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('treats a snapshot insert returning no row as a defect', async () => {
    const stats = {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      modalities: {},
    } as PublicUsageStats;
    await expect(
      stores.insertPublicStatsSnapshot(stubDb(Promise.resolve([])), { schemaVersion: 1, stats })
    ).rejects.toThrow('snapshot insert returned no row');
  });
});
