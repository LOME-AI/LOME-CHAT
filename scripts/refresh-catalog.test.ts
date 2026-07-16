import { describe, expect, it } from 'vitest';
import { formatRefreshSummary } from './refresh-catalog.js';
import type { ExcludeReason, RefreshSummary } from '@hushbox/api/dev-seed';

/** Build a `RefreshSummary` with a per-reason breakdown, zero-filling the rest. */
function summaryOf(
  totals: { discovered: number; written: number; unchanged: number },
  excludedByReason: Partial<Record<ExcludeReason, number>>
): RefreshSummary {
  const full: Record<ExcludeReason, number> = {
    'token-priced-image': 0,
    'token-priced-video': 0,
    'megapixel-priced-image': 0,
    'missing-pricing': 0,
    deprecated: 0,
    'unclassifiable-modality': 0,
    'missing-release-date': 0,
    'unknown-pricing-unit': 0,
    ...excludedByReason,
  };
  const excluded = Object.values(full).reduce((sum, count) => sum + count, 0);
  return { ...totals, excluded, excludedByReason: full };
}

describe('formatRefreshSummary', () => {
  it('lists only the non-zero exclusion categories in a fixed order', () => {
    const line = formatRefreshSummary(
      summaryOf(
        { discovered: 388, written: 357, unchanged: 0 },
        {
          'token-priced-image': 14,
          'token-priced-video': 3,
          deprecated: 5,
          'unknown-pricing-unit': 9,
        }
      )
    );
    expect(line).toBe(
      'catalog:refresh: 388 discovered, 357 written, 0 unchanged, ' +
        '31 excluded (14 token-priced-image, 3 token-priced-video, 5 deprecated, 9 unknown-pricing-unit).'
    );
  });

  it('omits the breakdown entirely when nothing was excluded', () => {
    const line = formatRefreshSummary(summaryOf({ discovered: 5, written: 5, unchanged: 0 }, {}));
    expect(line).toBe('catalog:refresh: 5 discovered, 5 written, 0 unchanged, 0 excluded.');
  });

  it('surfaces a lone unknown-pricing-unit (the real drift signal)', () => {
    const line = formatRefreshSummary(
      summaryOf({ discovered: 10, written: 8, unchanged: 1 }, { 'unknown-pricing-unit': 1 })
    );
    expect(line).toBe(
      'catalog:refresh: 10 discovered, 8 written, 1 unchanged, 1 excluded (1 unknown-pricing-unit).'
    );
  });
});
