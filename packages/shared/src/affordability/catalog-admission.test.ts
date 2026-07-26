import { describe, expect, it } from 'vitest';

import { MAX_MODEL_AGE_MS } from './constants.js';
import {
  exceedsModelAgeLimit,
  priceFloorVerdict,
  topContextExemptionTokens,
} from './catalog-admission.js';

/** The floor is $0.0002 per 1,000 combined tokens = 200 nano-USD per token. */
const FLOOR_NANO_PER_TOKEN = 200n;

const NOW_MS = Date.UTC(2026, 6, 1);

/** Release timestamps are UNIX SECONDS (OpenRouter's `created`). */
function releasedSecondsAgo(seconds: number): number {
  return Math.trunc(NOW_MS / 1000) - seconds;
}

describe('priceFloorVerdict', () => {
  it('reports zero for a model that charges nothing on either leg', () => {
    expect(priceFloorVerdict(0n, 0n)).toBe('zero');
  });

  it('reports meets-floor for a combined rate exactly at the floor', () => {
    expect(priceFloorVerdict(FLOOR_NANO_PER_TOKEN - 100n, 100n)).toBe('meets-floor');
  });

  it('reports below-floor one nano under the floor', () => {
    expect(priceFloorVerdict(FLOOR_NANO_PER_TOKEN - 101n, 100n)).toBe('below-floor');
  });

  it('reports meets-floor one nano over the floor', () => {
    expect(priceFloorVerdict(FLOOR_NANO_PER_TOKEN - 99n, 100n)).toBe('meets-floor');
  });
});

describe('exceedsModelAgeLimit', () => {
  it('admits a model released exactly at the cutoff', () => {
    expect(exceedsModelAgeLimit(releasedSecondsAgo(MAX_MODEL_AGE_MS / 1000), NOW_MS)).toBe(false);
  });

  it('rejects a model released one second before the cutoff', () => {
    expect(exceedsModelAgeLimit(releasedSecondsAgo(MAX_MODEL_AGE_MS / 1000 + 1), NOW_MS)).toBe(
      true
    );
  });

  it('admits a model released today', () => {
    expect(exceedsModelAgeLimit(releasedSecondsAgo(0), NOW_MS)).toBe(false);
  });
});

describe('topContextExemptionTokens', () => {
  it('exempts the top 5% of a hundred-model pool', () => {
    const pool = Array.from({ length: 100 }, (_, index) => (index + 1) * 1000);

    // sorted[floor(100 × 0.95)] = the 96th smallest, so the largest five qualify.
    expect(topContextExemptionTokens(pool)).toBe(96_000);
  });

  it('reads the pool in value order, not the order given', () => {
    expect(topContextExemptionTokens([200_000, 8000, 64_000, 1000, 32_000])).toBe(200_000);
  });

  it('exempts a lone model in a single-model pool', () => {
    expect(topContextExemptionTokens([8000])).toBe(8000);
  });

  it('returns zero for an empty pool', () => {
    expect(topContextExemptionTokens([])).toBe(0);
  });

  it('lands on the tied value when the top of the pool ties', () => {
    expect(topContextExemptionTokens([1000, 128_000, 128_000, 128_000])).toBe(128_000);
  });
});
