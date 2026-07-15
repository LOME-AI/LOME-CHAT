import { describe, expect, it } from 'vitest';
import { trimPage } from './pagination';

describe('trimPage', () => {
  it('reports hasMore and trims the sentinel row when over-fetched', () => {
    const rows = [1, 2, 3, 4]; // queried limit + 1 = 4 for a limit of 3
    const { page, hasMore } = trimPage(rows, 3);

    expect(hasMore).toBe(true);
    expect(page).toEqual([1, 2, 3]);
  });

  it('returns all rows and hasMore=false when the page is not full', () => {
    const rows = [1, 2];
    const { page, hasMore } = trimPage(rows, 3);

    expect(hasMore).toBe(false);
    expect(page).toBe(rows);
  });

  it('returns all rows and hasMore=false at exactly the limit', () => {
    const rows = [1, 2, 3];
    const { page, hasMore } = trimPage(rows, 3);

    expect(hasMore).toBe(false);
    expect(page).toEqual([1, 2, 3]);
  });

  it('handles the empty page', () => {
    const { page, hasMore } = trimPage([], 3);

    expect(hasMore).toBe(false);
    expect(page).toEqual([]);
  });

  it('is byte-identical to the prior inline over-fetch idiom', () => {
    const inline = <T>(
      rows: readonly T[],
      limit: number
    ): { page: readonly T[]; hasMore: boolean } => {
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return { page, hasMore };
    };
    for (const [rows, limit] of [
      [[1, 2, 3, 4], 3],
      [[1, 2], 3],
      [[1, 2, 3], 3],
      [[], 3],
      [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 10],
    ] as [number[], number][]) {
      const got = trimPage(rows, limit);
      const want = inline(rows, limit);
      expect(got.hasMore).toBe(want.hasMore);
      expect(got.page).toEqual(want.page);
    }
  });
});
