import { describe, expect, it, vi } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { DEFAULT_USAGE_PAGE_LIMIT, readUsageBreakdown } from './usage-analytics.js';
import type { Database } from '@hushbox/db';
import type { BillingStores, UsageBreakdownQuery, UsageBreakdownRow } from '../ports/stores.js';

const DB = {} as Database;

function row(modelCatalogId: string): UsageBreakdownRow {
  return { modelCatalogId, totalNanoUsd: 1000n, recordCount: 1, estimatedCount: 0 };
}

function fakeStores(
  rows: readonly UsageBreakdownRow[],
  spy?: (query: UsageBreakdownQuery) => void
): BillingStores {
  return {
    aggregateUsageByModel: (_db: Database, query: UsageBreakdownQuery) => {
      spy?.(query);
      return okAsync(rows.slice(0, query.limit));
    },
  } as unknown as BillingStores;
}

describe('readUsageBreakdown', () => {
  it('requests one more than the page limit to detect a further page', async () => {
    const spy = vi.fn();
    const result = await readUsageBreakdown(fakeStores([], spy), DB, { userId: 'u-1', limit: 2 });
    expect(result.isOk()).toBe(true);
    expect(spy.mock.calls[0]?.[0].limit).toBe(3);
  });

  it('defaults the page limit when none is given', async () => {
    const spy = vi.fn();
    const result = await readUsageBreakdown(fakeStores([], spy), DB, { userId: 'u-1' });
    expect(result.isOk()).toBe(true);
    expect(spy.mock.calls[0]?.[0].limit).toBe(DEFAULT_USAGE_PAGE_LIMIT + 1);
  });

  it('passes the cursor through to the store when provided', async () => {
    const spy = vi.fn();
    const result = await readUsageBreakdown(fakeStores([], spy), DB, {
      userId: 'u-1',
      cursor: 'cur',
    });
    expect(result.isOk()).toBe(true);
    expect(spy.mock.calls[0]?.[0].cursor).toBe('cur');
  });

  it('scopes the aggregation to the caller userId', async () => {
    const spy = vi.fn();
    const result = await readUsageBreakdown(fakeStores([], spy), DB, { userId: 'u-1' });
    expect(result.isOk()).toBe(true);
    expect(spy.mock.calls[0]?.[0].userId).toBe('u-1');
  });

  it('returns the last page id as the next cursor when a further page exists', async () => {
    const rows = [row('a'), row('b'), row('c')];
    const result = await readUsageBreakdown(fakeStores(rows), DB, { userId: 'u-1', limit: 2 });
    const page = result._unsafeUnwrap();
    expect(page.models.map((m) => m.modelCatalogId)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe('b');
  });

  it('returns a null next cursor on the final page', async () => {
    const rows = [row('a'), row('b')];
    const result = await readUsageBreakdown(fakeStores(rows), DB, { userId: 'u-1', limit: 5 });
    const page = result._unsafeUnwrap();
    expect(page.models).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('returns a null next cursor for an empty result', async () => {
    const result = await readUsageBreakdown(fakeStores([]), DB, { userId: 'u-1' });
    expect(result._unsafeUnwrap().nextCursor).toBeNull();
  });
});
