import { describe, it, expect } from 'vitest';
import {
  ALL_FEE_CATEGORIES,
  FEE_BUCKET_BY_ID,
  FEE_CATEGORIES,
  formatFeePercent,
  roundPreservingSum,
  type FeeBucketId,
  type FeeCategory,
  type FeeCategoryId,
} from './fees.js';
import { HUSHBOX_FEE_RATE, CREDIT_CARD_FEE_RATE, PROVIDER_FEE_RATE } from './constants.js';

describe('ALL_FEE_CATEGORIES', () => {
  it('has exactly three categories', () => {
    expect(ALL_FEE_CATEGORIES).toHaveLength(3);
  });

  it('uses stable identifiers', () => {
    const ids = ALL_FEE_CATEGORIES.map((c) => c.id);
    expect(ids).toEqual(['hushbox', 'card-processing', 'provider']);
  });

  it('reads rates through to the constants module', () => {
    const rateById = Object.fromEntries(ALL_FEE_CATEGORIES.map((c) => [c.id, c.rate]));
    expect(rateById['hushbox']).toBe(HUSHBOX_FEE_RATE);
    expect(rateById['card-processing']).toBe(CREDIT_CARD_FEE_RATE);
    expect(rateById['provider']).toBe(PROVIDER_FEE_RATE);
  });

  it('has a label, shortLabel, and description on every entry', () => {
    for (const c of ALL_FEE_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.shortLabel.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it('uses sentence-flow casing for the canonical label', () => {
    const labelById = Object.fromEntries(ALL_FEE_CATEGORIES.map((c) => [c.id, c.label]));
    expect(labelById['hushbox']).toBe('HushBox margin');
    expect(labelById['card-processing']).toBe('credit card processing');
    expect(labelById['provider']).toBe('AI provider overhead');
  });

  it('has a usable shortLabel for compact surfaces', () => {
    const shortById = Object.fromEntries(ALL_FEE_CATEGORIES.map((c) => [c.id, c.shortLabel]));
    expect(shortById['hushbox']).toBe('HushBox');
    expect(shortById['card-processing']).toBe('Card processing');
    expect(shortById['provider']).toBe('Provider overhead');
  });
});

describe('FEE_CATEGORIES', () => {
  it('omits any category with rate of zero', () => {
    for (const c of FEE_CATEGORIES) {
      expect(c.rate).toBeGreaterThan(0);
    }
  });

  it('contains every non-zero category from ALL_FEE_CATEGORIES', () => {
    const expected = ALL_FEE_CATEGORIES.filter((c) => c.rate > 0);
    expect(FEE_CATEGORIES).toEqual(expected);
  });

  it('preserves the order from ALL_FEE_CATEGORIES', () => {
    const allIds = ALL_FEE_CATEGORIES.filter((c) => c.rate > 0).map((c) => c.id);
    const filteredIds = FEE_CATEGORIES.map((c) => c.id);
    expect(filteredIds).toEqual(allIds);
  });
});

describe('formatFeePercent', () => {
  it('formats common rates as percent strings', () => {
    expect(formatFeePercent(0.05)).toBe('5%');
    expect(formatFeePercent(0.045)).toBe('4.5%');
    expect(formatFeePercent(0.055)).toBe('5.5%');
    expect(formatFeePercent(0.15)).toBe('15%');
    expect(formatFeePercent(0.095)).toBe('9.5%');
  });

  it('formats zero as "0%"', () => {
    expect(formatFeePercent(0)).toBe('0%');
  });

  it('formats integer-percent rates without a decimal', () => {
    expect(formatFeePercent(0.1)).toBe('10%');
  });

  it('clamps floating-point artifacts that arise from rate arithmetic', () => {
    // 0.1 + 0.2 → 0.30000000000000004 in IEEE 754, ×100 → 30.000000000000004
    expect(formatFeePercent(0.1 + 0.2)).toBe('30%');
  });

  it('clamps the artifact from summing the original three fee rates', () => {
    // 0.05 + 0.045 + 0.055 → 0.15000000000000002 in IEEE 754
    expect(formatFeePercent(0.05 + 0.045 + 0.055)).toBe('15%');
  });

  it('preserves a fractional percent without trailing zeros', () => {
    expect(formatFeePercent(0.0455)).toBe('4.55%');
  });
});

describe('roundPreservingSum', () => {
  it('returns an empty array for empty input', () => {
    expect(roundPreservingSum([])).toEqual([]);
  });

  it('returns floors when remainder is zero', () => {
    expect(roundPreservingSum([10, 20, 70])).toEqual([10, 20, 70]);
  });

  it('distributes remainder to the largest fractional parts (Hare-Niemeyer)', () => {
    // [33.3, 33.3, 33.3] sums to 99.9 → target 100; remainder 1; index 0 wins on tie.
    expect(roundPreservingSum([33.3, 33.3, 33.3])).toEqual([34, 33, 33]);
  });

  it('preserves a sum that is not 100', () => {
    // [1.6, 2.6, 0.8] sums to 5; floors [1, 2, 0] sum to 3; remainder 2.
    // Fracs: [0.6, 0.6, 0.8] → sort desc, index 2 first, then 0; result [2, 2, 1].
    expect(roundPreservingSum([1.6, 2.6, 0.8])).toEqual([2, 2, 1]);
  });

  it('breaks ties by lower index for stability', () => {
    // [0.5, 0.5] sums to 1; floors [0, 0]; remainder 1; index 0 wins.
    expect(roundPreservingSum([0.5, 0.5])).toEqual([1, 0]);
  });

  it('handles all-zero inputs', () => {
    expect(roundPreservingSum([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('handles a single value', () => {
    expect(roundPreservingSum([99.7])).toEqual([100]);
  });

  it('handles values that already sum to a whole percentage', () => {
    expect(roundPreservingSum([50, 25, 25])).toEqual([50, 25, 25]);
  });

  it('produces output whose sum equals Math.round of the input sum', () => {
    const inputs: readonly (readonly number[])[] = [
      [12.4, 7.6, 80],
      [1.1, 2.2, 3.3, 4.4],
      [99.49, 0.51],
      [33.34, 33.33, 33.33],
    ];
    for (const values of inputs) {
      const target = Math.round(values.reduce((sum, v) => sum + v, 0));
      const rounded = roundPreservingSum(values);
      expect(rounded.reduce((sum, v) => sum + v, 0)).toBe(target);
    }
  });
});

describe('FEE_BUCKET_BY_ID', () => {
  it('has an entry for every FeeCategoryId', () => {
    const allIds = ALL_FEE_CATEGORIES.map((c) => c.id);
    for (const id of allIds) {
      expect(FEE_BUCKET_BY_ID[id]).toBeDefined();
    }
  });

  it('assigns card-processing and provider to the transaction-costs bucket', () => {
    expect(FEE_BUCKET_BY_ID['card-processing']).toBe('transaction-costs');
    expect(FEE_BUCKET_BY_ID.provider).toBe('transaction-costs');
  });

  it('assigns hushbox to the platform-fee bucket', () => {
    expect(FEE_BUCKET_BY_ID.hushbox).toBe('platform-fee');
  });

  it('uses only the FeeBucketId values', () => {
    const validBuckets: FeeBucketId[] = ['transaction-costs', 'platform-fee'];
    for (const id of ALL_FEE_CATEGORIES.map((c) => c.id)) {
      expect(validBuckets).toContain(FEE_BUCKET_BY_ID[id]);
    }
  });
});

describe('FeeCategory exports', () => {
  it('exports the FeeCategoryId type with all three values', () => {
    const ids: FeeCategoryId[] = ['hushbox', 'card-processing', 'provider'];
    const allIds = ALL_FEE_CATEGORIES.map((c) => c.id);
    expect(allIds).toEqual(ids);
  });

  it('exports the FeeCategory interface shape', () => {
    const sample: FeeCategory = ALL_FEE_CATEGORIES[0]!;
    expect(typeof sample.id).toBe('string');
    expect(typeof sample.label).toBe('string');
    expect(typeof sample.shortLabel).toBe('string');
    expect(typeof sample.description).toBe('string');
    expect(typeof sample.rate).toBe('number');
  });
});
