/**
 * Gateway pricing rates arrive as decimal USD strings (for example
 * "0.0000025" per token); catalog pricing is integer nano-USD strings
 * (the `NanoUSD` wire form). The conversion is exact string math — never
 * float — and rounds half-even once when a rate carries more than nine
 * fractional digits. An unparseable or negative rate returns `undefined` so
 * the caller omits it, which keeps exposure fail-closed (a model whose
 * pricing cannot be represented stays unpriced and therefore hidden).
 */

const DECIMAL_USD_PATTERN = /^\d+(?:\.\d+)?$/;

const NANO_FRACTION_DIGITS = 9;

export function usdRateToNanoUsd(rate: string): string | undefined {
  if (!DECIMAL_USD_PATTERN.test(rate)) return undefined;
  const dot = rate.indexOf('.');
  const whole = dot === -1 ? rate : rate.slice(0, dot);
  const fraction = dot === -1 ? '' : rate.slice(dot + 1);
  const nanoDigits = fraction.slice(0, NANO_FRACTION_DIGITS).padEnd(NANO_FRACTION_DIGITS, '0');
  const remainder = fraction.slice(NANO_FRACTION_DIGITS);
  let nano = BigInt(whole) * 10n ** BigInt(NANO_FRACTION_DIGITS) + BigInt(nanoDigits);
  if (roundsUpHalfEven(remainder, nano)) nano += 1n;
  return nano.toString(10);
}

/** Half-even on the digits beyond nano precision: >half up, <half down,
 * exactly half toward the even nano value. */
function roundsUpHalfEven(remainder: string, nano: bigint): boolean {
  if (remainder.length === 0) return false;
  const head = remainder.slice(0, 1);
  const tail = remainder.slice(1);
  const tailNonZero = /[1-9]/.test(tail);
  if (head > '5' || (head === '5' && tailNonZero)) return true;
  if (head < '5') return false;
  return nano % 2n === 1n;
}
