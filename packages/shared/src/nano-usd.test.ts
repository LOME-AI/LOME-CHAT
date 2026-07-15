import { describe, expect, it } from 'vitest';
import {
  NanoUSD,
  NANO_USD_PER_CENT,
  nanoUSD,
  nanoUsdToCents,
  nanoUsdToDollarString,
  centsToNanoUsd,
  dollarsToCents,
  dollarsToNanoUsd,
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

describe('NANO_USD_PER_CENT', () => {
  it('is 10^7 nano-USD per cent', () => {
    expect(NANO_USD_PER_CENT).toBe(10_000_000n);
  });
});

describe('dollarsToCents', () => {
  // The two hand-rolled web parsers this replaces. `budgetParseFloat` is the
  // budget-settings modal's `Math.round(parseFloat * 100)`; `paymentBigintSplit`
  // is the payment form's integer split. Byte-identity across the validated
  // money domain is the consolidation invariant.
  const budgetParseFloat = (d: string): number => Math.round(Number.parseFloat(d) * 100);
  const paymentBigintSplit = (amount: string): bigint => {
    const [whole = '0', fraction = ''] = amount.split('.');
    const wholeDigits = whole.length > 0 ? whole : '0';
    return BigInt(wholeDigits) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  };

  it.each([
    ['0.10', 10],
    ['5.00', 500],
    ['10.99', 1099],
    ['0.1', 10],
    ['5.5', 550],
    ['5.05', 505],
    ['0.29', 29],
    ['1000', 100_000],
    ['0', 0],
    ['0.00', 0],
    ['.5', 50],
    ['5.', 500],
  ])('parses %j to %d cents with no float drift', (input, expected) => {
    expect(dollarsToCents(input)).toBe(expected);
  });

  it('matches both prior web parsers across the validated money domain', () => {
    for (const d of ['0.10', '5.00', '10.99', '0.1', '5.5', '5.05', '0.29', '1000', '0', '0.00']) {
      expect(dollarsToCents(d)).toBe(budgetParseFloat(d));
      expect(BigInt(dollarsToCents(d))).toBe(paymentBigintSplit(d));
    }
  });
});

describe('centsToNanoUsd', () => {
  it('scales whole cents to a canonical nano-USD string', () => {
    expect(centsToNanoUsd(0)).toBe('0');
    expect(centsToNanoUsd(500)).toBe('5000000000');
    expect(centsToNanoUsd(1099)).toBe('10990000000');
  });

  it('matches the prior budget-hook `BigInt(cents) * 10_000_000n` math', () => {
    for (const cents of [0, 1, 10, 500, 2500, 100_000]) {
      expect(centsToNanoUsd(cents)).toBe((BigInt(cents) * 10_000_000n).toString());
    }
  });
});

describe('dollarsToNanoUsd', () => {
  it('parses a dollar string to a canonical nano-USD string', () => {
    expect(dollarsToNanoUsd('5')).toBe('5000000000');
    expect(dollarsToNanoUsd('10.99')).toBe('10990000000');
    expect(dollarsToNanoUsd('0.10')).toBe('100000000');
  });

  it('matches the prior payment-form `(cents * 10_000_000n).toString()` math', () => {
    for (const d of ['5', '10.99', '0.10', '0.1', '1000', '5.05']) {
      const [whole = '0', fraction = ''] = d.split('.');
      const wholeDigits = whole.length > 0 ? whole : '0';
      const cents = BigInt(wholeDigits) * 100n + BigInt(`${fraction}00`.slice(0, 2));
      expect(dollarsToNanoUsd(d)).toBe((cents * 10_000_000n).toString());
    }
  });
});
