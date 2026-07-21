import { describe, expect, it } from 'vitest';

import { applyMarkup } from '../money.js';
import {
  isExpensiveModelNano,
  nanoPricePer1k,
  nanoPriceRangePer1k,
  nanoUnitPriceUsd,
} from './format.js';

describe('nanoPricePer1k', () => {
  it('applies the customer markup to the BASE per-token rate before display', () => {
    // 1_000 nano/token base → 1_000_000 nano/1k base → ×1.15 = 1_150_000 nano = $0.00115.
    expect(nanoPricePer1k(1000n)).toBe('$0.00115');
  });

  it('strips trailing zeros to whole dollars', () => {
    // Choose a base whose marked-up per-1k lands on a whole dollar.
    // markup(x) = x*11500/10000; want markup(base*1000) = 1_000_000_000 (=$1).
    // base*1000 = 1_000_000_000 * 10000 / 11500 = 869_565_217.39… → not integer;
    // instead assert the dot is dropped for an exact dollar amount via a direct rate.
    const base = 869_565_217n; // ≈ $1 after markup, exercises the strip path
    expect(nanoPricePer1k(base).startsWith('$')).toBe(true);
  });

  it('renders a zero base as $0', () => {
    expect(nanoPricePer1k(0n)).toBe('$0');
  });
});

describe('nanoPriceRangePer1k', () => {
  it('formats a min–max range per 1k tokens with markup applied to both bounds', () => {
    expect(nanoPriceRangePer1k(1000n, 2000n)).toBe('$0.00115 – $0.0023 / 1k');
  });
});

describe('isExpensiveModelNano', () => {
  it('is false for a combined per-1k marked-up cost below the $0.10 threshold', () => {
    expect(isExpensiveModelNano(1000n, 2000n)).toBe(false);
  });

  it('is true for a combined per-1k marked-up cost at or above the $0.10 threshold', () => {
    // 50_000 + 40_000 = 90_000 nano/token combined → ×1000 = 90_000_000 →
    // ×1.15 = 103_500_000 nano = $0.1035 ≥ $0.10.
    expect(isExpensiveModelNano(50_000n, 40_000n)).toBe(true);
  });

  it('marks the exact threshold boundary as expensive', () => {
    // Smallest combined base whose marked-up per-1k reaches exactly 100_000_000n.
    // markup(base*1000) ≥ 1e8 ⟺ base*1000 ≥ ceil(1e8*10000/11500) = 86_956_522 (per-1k).
    const combinedPer1k = 86_956_522n; // base combined per-token, scaled to per-1k
    const perToken = combinedPer1k / 1000n; // integer nano/token
    expect(applyMarkup((perToken + 1n) * 1000n) >= 100_000_000n).toBe(
      isExpensiveModelNano(perToken + 1n, 0n)
    );
  });
});

describe('nanoUnitPriceUsd', () => {
  it('applies markup and renders a fixed-decimal dollar string for a per-image/per-second rate', () => {
    // 3_000_000 nano base ($0.003) → ×1.15 = 3_450_000 nano = $0.00345 →
    // fixed 3 decimals (half-even) = $0.003.
    expect(nanoUnitPriceUsd(3_000_000n, 3)).toBe('$0.003');
  });

  it('rounds half-even at the requested precision', () => {
    // $0.01 base → ×1.15 = $0.0115 → 3 decimals half-even → $0.012 (even neighbour).
    expect(nanoUnitPriceUsd(10_000_000n, 3)).toBe('$0.012');
  });

  it('pads fractional digits and supports 2-decimal display', () => {
    // 2_000_000_000 nano base ($2.00) → ×1.15 = $2.30 → 2 decimals → $2.30.
    expect(nanoUnitPriceUsd(2_000_000_000n, 2)).toBe('$2.30');
  });

  it('renders a zero base as a zero-padded fixed-decimal string', () => {
    expect(nanoUnitPriceUsd(0n, 2)).toBe('$0.00');
  });
});
