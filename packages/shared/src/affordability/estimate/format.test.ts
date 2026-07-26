import { describe, expect, it } from 'vitest';

import {
  isExpensiveModelNano,
  nanoPricePer1k,
  nanoPriceRangePer1k,
  nanoUnitPriceUsd,
} from './format.js';

describe('nanoPricePer1k', () => {
  it('renders the billable per-token rate per 1k tokens with no fee math', () => {
    // 1_150 nano/token billable → 1_150_000 nano/1k = $0.00115.
    expect(nanoPricePer1k(1150n)).toBe('$0.00115');
  });

  it('strips trailing zeros', () => {
    // 1_000 nano/token billable → 1_000_000 nano/1k = $0.001.
    expect(nanoPricePer1k(1000n)).toBe('$0.001');
  });

  it('renders a zero rate as $0', () => {
    expect(nanoPricePer1k(0n)).toBe('$0');
  });
});

describe('nanoPriceRangePer1k', () => {
  it('formats a min–max range per 1k tokens from billable bounds', () => {
    expect(nanoPriceRangePer1k(1150n, 2300n)).toBe('$0.00115 – $0.0023 / 1k');
  });
});

describe('isExpensiveModelNano', () => {
  it('is false for a combined billable per-1k cost below the $0.10 threshold', () => {
    expect(isExpensiveModelNano(1000n, 2000n)).toBe(false);
  });

  it('is true for a combined billable per-1k cost at or above the $0.10 threshold', () => {
    // 60_000 + 45_000 = 105_000 nano/token combined → ×1000 = 105_000_000 nano
    // = $0.105 ≥ $0.10.
    expect(isExpensiveModelNano(60_000n, 45_000n)).toBe(true);
  });

  it('marks the exact threshold boundary as expensive', () => {
    // 100_000 nano/token combined → ×1000 = exactly 100_000_000 nano = $0.10.
    expect(isExpensiveModelNano(60_000n, 40_000n)).toBe(true);
    expect(isExpensiveModelNano(60_000n, 40_000n - 1n)).toBe(false);
  });
});

describe('nanoUnitPriceUsd', () => {
  it('renders a billable per-image/per-second rate as a fixed-decimal dollar string', () => {
    // 3_450_000 nano ($0.00345) → fixed 3 decimals (half-even) = $0.003.
    expect(nanoUnitPriceUsd(3_450_000n, 3)).toBe('$0.003');
  });

  it('rounds half-even at the requested precision', () => {
    // $0.0115 → 3 decimals half-even → $0.012 (even neighbour).
    expect(nanoUnitPriceUsd(11_500_000n, 3)).toBe('$0.012');
  });

  it('pads fractional digits and supports 2-decimal display', () => {
    // 2_300_000_000 nano ($2.30) → 2 decimals → $2.30.
    expect(nanoUnitPriceUsd(2_300_000_000n, 2)).toBe('$2.30');
  });

  it('renders a zero rate as a zero-padded fixed-decimal string', () => {
    expect(nanoUnitPriceUsd(0n, 2)).toBe('$0.00');
  });
});
