import { describe, expect, it } from 'vitest';
import {
  NanoUSD,
  nanoUSD,
  nanoUsdToCents,
  nanoUsdToDollarString,
  parseNanoUSD,
  serializeNanoUSD,
} from './nano-usd.js';
import { bigIntOfBits, intBetween, mulberry32 } from './__tests__/seeded-prng.js';

describe('NanoUSD schema', () => {
  it('parses a decimal string into a bigint', () => {
    expect(NanoUSD.parse('1500000000')).toBe(1_500_000_000n);
  });

  it('parses a negative decimal string', () => {
    expect(NanoUSD.parse('-42')).toBe(-42n);
  });

  it('parses zero', () => {
    expect(NanoUSD.parse('0')).toBe(0n);
  });

  it('parses values beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
    expect(NanoUSD.parse('9007199254740993')).toBe(9_007_199_254_740_993n);
  });

  it('rejects a bigint input (wire format is string-only)', () => {
    expect(NanoUSD.safeParse(123n).success).toBe(false);
  });

  it('rejects a number input', () => {
    expect(NanoUSD.safeParse(123).success).toBe(false);
  });

  it('rejects a decimal-point string', () => {
    expect(NanoUSD.safeParse('1.5').success).toBe(false);
  });

  it('rejects leading zeros', () => {
    expect(NanoUSD.safeParse('007').success).toBe(false);
  });

  it('rejects negative zero', () => {
    expect(NanoUSD.safeParse('-0').success).toBe(false);
  });

  it('rejects an explicit plus sign', () => {
    expect(NanoUSD.safeParse('+5').success).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(NanoUSD.safeParse('').success).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    expect(NanoUSD.safeParse('12a3').success).toBe(false);
  });
});

describe('nanoUSD', () => {
  it('brands a raw bigint', () => {
    const value = nanoUSD(7n);
    expect(value).toBe(7n);
  });
});

describe('NanoUSD brand (compile-time)', () => {
  // If the brand ever eroded (plain bigint became assignable), the directive
  // would be flagged unused and `tsgo --noEmit` would fail.
  it('rejects a plain bigint where NanoUSD is expected', () => {
    // @ts-expect-error — unbranded bigint is not assignable to NanoUSD
    const serialized = serializeNanoUSD(7n);
    expect(serialized).toBe('7');
  });
});

describe('serializeNanoUSD', () => {
  it('serializes to a decimal string', () => {
    expect(serializeNanoUSD(nanoUSD(1_500_000_000n))).toBe('1500000000');
  });

  it('serializes negative values', () => {
    expect(serializeNanoUSD(nanoUSD(-42n))).toBe('-42');
  });
});

describe('parseNanoUSD', () => {
  it('returns the branded bigint for a valid string', () => {
    expect(parseNanoUSD('99')).toBe(99n);
  });

  it('throws on an invalid string', () => {
    expect(() => parseNanoUSD('1.5')).toThrow();
  });
});

describe('nanoUsdToCents', () => {
  it('converts one cent of nano-USD to 1 cent', () => {
    expect(nanoUsdToCents('10000000')).toBe(1);
  });

  it('converts a whole-dollar amount to cents', () => {
    // $50.00 = 5_000 cents = 5e10 nano
    expect(nanoUsdToCents('50000000000')).toBe(5000);
  });

  it('is negative-capable', () => {
    expect(nanoUsdToCents('-5000000000')).toBe(-500);
  });

  it('truncates sub-cent nano toward zero', () => {
    // 1 cent + 999_999 nano (< 1 cent) → 1 cent
    expect(nanoUsdToCents('10999999')).toBe(1);
  });

  it('is zero for zero', () => {
    expect(nanoUsdToCents('0')).toBe(0);
  });
});

describe('nanoUsdToDollarString', () => {
  it('formats a whole-dollar amount with two decimals', () => {
    expect(nanoUsdToDollarString('50000000000')).toBe('50.00');
  });

  it('formats a cents-precise amount', () => {
    // $42.50 = 4_250 cents = 4.25e10 nano
    expect(nanoUsdToDollarString('42500000000')).toBe('42.50');
  });

  it('formats a negative amount with a leading minus', () => {
    expect(nanoUsdToDollarString('-25000000000')).toBe('-25.00');
  });

  it('pads single-digit cents', () => {
    // $10.05 = 1_005 cents = 1.005e10 nano
    expect(nanoUsdToDollarString('10050000000')).toBe('10.05');
  });

  it('truncates sub-cent precision for display', () => {
    // $8.00 + 999_999 nano (< 1 cent) → "8.00"
    expect(nanoUsdToDollarString('8000999999')).toBe('8.00');
  });

  it('formats zero', () => {
    expect(nanoUsdToDollarString('0')).toBe('0.00');
  });
});

describe('round-trip property (seeded)', () => {
  it('parse(serialize(v)) === v for random bigints incl. >2^53, negatives, zero', () => {
    const rng = mulberry32(0xc0_ff_ee);
    const cases: bigint[] = [0n, -1n, 2n ** 53n + 1n, -(2n ** 64n)];
    for (let index = 0; index < 200; index += 1) {
      const magnitude = bigIntOfBits(rng, intBetween(rng, 1, 96));
      cases.push(intBetween(rng, 0, 1) === 0 ? magnitude : -magnitude);
    }
    for (const raw of cases) {
      const value = nanoUSD(raw);
      expect(parseNanoUSD(serializeNanoUSD(value))).toBe(value);
    }
  });

  it('serialize(parse(s)) === s for canonical decimal strings (seeded)', () => {
    const rng = mulberry32(0xde_ad_be_ef);
    for (let index = 0; index < 200; index += 1) {
      const magnitude = bigIntOfBits(rng, intBetween(rng, 1, 96));
      const sign = magnitude !== 0n && intBetween(rng, 0, 1) === 0 ? '-' : '';
      const canonical = `${sign}${magnitude.toString(10)}`;
      expect(serializeNanoUSD(parseNanoUSD(canonical))).toBe(canonical);
    }
  });
});
