import { describe, expect, it } from 'vitest';
import {
  MARKUP_BASIS_POINTS,
  applyMarkup,
  applyMarkupCeil,
  roundHalfEvenDiv,
  usdToNanoUsd,
} from './money.js';

describe('MARKUP_BASIS_POINTS', () => {
  it('is the published 15%-over-provider-cost markup', () => {
    expect(MARKUP_BASIS_POINTS).toBe(1500n);
  });
});

describe('roundHalfEvenDiv', () => {
  it('divides exactly when there is no remainder', () => {
    expect(roundHalfEvenDiv(100n, 10n)).toBe(10n);
  });

  it('rounds down below the midpoint', () => {
    expect(roundHalfEvenDiv(14n, 10n)).toBe(1n);
  });

  it('rounds up above the midpoint', () => {
    expect(roundHalfEvenDiv(16n, 10n)).toBe(2n);
  });

  it('rounds a midpoint to the even neighbor going down', () => {
    expect(roundHalfEvenDiv(45n, 10n)).toBe(4n);
  });

  it('rounds a midpoint to the even neighbor going up', () => {
    expect(roundHalfEvenDiv(35n, 10n)).toBe(4n);
  });

  it('rounds negative midpoints to the even neighbor', () => {
    expect(roundHalfEvenDiv(-45n, 10n)).toBe(-4n);
    expect(roundHalfEvenDiv(-35n, 10n)).toBe(-4n);
  });

  it('rejects a non-positive denominator', () => {
    expect(() => roundHalfEvenDiv(1n, 0n)).toThrow(/positive/);
    expect(() => roundHalfEvenDiv(1n, -10n)).toThrow(/positive/);
  });
});

describe('applyMarkup', () => {
  it('adds 15% to a whole-dollar base cost', () => {
    expect(applyMarkup(1_000_000_000n)).toBe(1_150_000_000n);
  });

  it('returns zero for a zero base', () => {
    expect(applyMarkup(0n)).toBe(0n);
  });

  it('rounds a sub-nano midpoint half-even up to the even neighbor', () => {
    // 10 × 1.15 = 11.5 → 12 (11 is odd)
    expect(applyMarkup(10n)).toBe(12n);
  });

  it('rounds a sub-nano midpoint half-even down to the even neighbor', () => {
    // 30 × 1.15 = 34.5 → 34 (even)
    expect(applyMarkup(30n)).toBe(34n);
  });

  it('rejects a negative base cost', () => {
    expect(() => applyMarkup(-1n)).toThrow(/negative/);
  });
});

describe('applyMarkupCeil', () => {
  it('adds exactly 15% to a whole-dollar base cost (no rounding needed)', () => {
    expect(applyMarkupCeil(1_000_000_000n)).toBe(1_150_000_000n);
  });

  it('returns zero for a zero base', () => {
    expect(applyMarkupCeil(0n)).toBe(0n);
  });

  it('rounds any fractional nano up, against the user', () => {
    // 1 × 1.15 = 1.15 → 2
    expect(applyMarkupCeil(1n)).toBe(2n);
    // 3 × 1.15 = 3.45 → 4
    expect(applyMarkupCeil(3n)).toBe(4n);
  });

  it('diverges from half-even at a midpoint that half-even rounds down', () => {
    // 30 × 1.15 = 34.5: half-even lands on the even 34; ceil charges 35.
    expect(applyMarkup(30n)).toBe(34n);
    expect(applyMarkupCeil(30n)).toBe(35n);
  });

  it('diverges from half-even below the midpoint', () => {
    // 2 × 1.15 = 2.3: half-even rounds to 2; ceil charges 3.
    expect(applyMarkup(2n)).toBe(2n);
    expect(applyMarkupCeil(2n)).toBe(3n);
  });

  it('is exact on magnitudes far beyond float precision', () => {
    const base = 10n ** 30n + 1n;
    // ×1.15 exactly: (10^30 + 1) × 23 / 20 has remainder 3/20 → ceil adds 1.
    expect(applyMarkupCeil(base)).toBe((base * 23n) / 20n + 1n);
  });

  it('always returns the least integer ≥ the exact 1.15× product (ceil property)', () => {
    const basis = 10_000n;
    const rate = basis + MARKUP_BASIS_POINTS;
    for (let base = 0n; base < 2000n; base += 1n) {
      const result = applyMarkupCeil(base);
      const exact = base * rate;
      expect(result * basis).toBeGreaterThanOrEqual(exact);
      if (result > 0n) expect((result - 1n) * basis).toBeLessThan(exact);
    }
  });

  it('never charges less than the half-even markup (only-over-reserve invariant)', () => {
    for (let base = 0n; base < 2000n; base += 1n) {
      expect(applyMarkupCeil(base)).toBeGreaterThanOrEqual(applyMarkup(base));
    }
  });

  it('rejects a negative base cost', () => {
    expect(() => applyMarkupCeil(-1n)).toThrow(/negative/);
  });
});

describe('usdToNanoUsd', () => {
  it('converts whole dollars exactly', () => {
    expect(usdToNanoUsd(1.15)).toBe(1_150_000_000n);
  });

  it('converts zero', () => {
    expect(usdToNanoUsd(0)).toBe(0n);
  });

  it('converts one nano-USD exactly', () => {
    expect(usdToNanoUsd(0.000_000_001)).toBe(1n);
  });

  it('rounds a sub-nano midpoint half-even to the even neighbor', () => {
    expect(usdToNanoUsd(0.000_000_000_5)).toBe(0n);
    expect(usdToNanoUsd(0.000_000_001_5)).toBe(2n);
  });

  it('rounds sub-nano residue below the midpoint down', () => {
    expect(usdToNanoUsd(0.000_000_001_4)).toBe(1n);
  });

  it('rejects negative amounts', () => {
    expect(() => usdToNanoUsd(-0.01)).toThrow(/negative/);
  });

  it('rejects non-finite amounts', () => {
    expect(() => usdToNanoUsd(Number.NaN)).toThrow(/finite/);
    expect(() => usdToNanoUsd(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});
