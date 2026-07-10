import {
  MEDIA_STORAGE_COST_PER_BYTE,
  STORAGE_COST_PER_CHARACTER,
  TOTAL_FEE_RATE,
} from '@hushbox/shared';

/**
 * Money math for the billing slice: integer nano-USD `bigint` end to end,
 * banker's (half-even) rounding applied exactly once at the settlement seam.
 * No float ever touches ledger amounts; the only float input in the system is
 * the gateway's per-generation `total_cost` USD figure, converted here via
 * its decimal-string rendering.
 */

const BASIS = 10_000n;

/**
 * The 15%-over-provider-cost markup in basis points. Kept as an exact bigint
 * (float rate math is banned on money); the assertion below fails fast if the
 * shared marketing-facing rate ever drifts from this settlement constant.
 */
export const MARKUP_BASIS_POINTS = 1500n;

/** Fail-fast guard, run at module init: the two rate constants must agree. */
export function assertMarkupMatchesSharedRate(totalFeeRate: number): void {
  if (BigInt(Math.round(totalFeeRate * 10_000)) !== MARKUP_BASIS_POINTS) {
    throw new Error(
      'billing: MARKUP_BASIS_POINTS no longer matches the shared TOTAL_FEE_RATE — update both together'
    );
  }
}

assertMarkupMatchesSharedRate(TOTAL_FEE_RATE);

/** 1 USD in nano-USD — the scale that turns the shared float rates into integers. */
const NANO_PER_USD = 1e9;

/**
 * Storage fees in exact integer nano-USD, charged ADDITIVELY and NEVER marked
 * up (storage is a pass-through cost, not a provider cost). Kept as exact
 * bigints (float rate math is banned on money); the assertion below fails fast
 * if either shared float rate ever drifts from its settlement constant.
 *   - $0.0000003/char = 300 nano-USD/char
 *   - $0.000000018/byte = 18 nano-USD/byte
 */
export const STORAGE_COST_PER_CHARACTER_NANO = 300n;
export const MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n;

/** Fail-fast guard, run at module init: the nano constants must match the shared floats. */
export function assertStorageRatesMatchSharedFloats(charRate: number, byteRate: number): void {
  if (BigInt(Math.round(charRate * NANO_PER_USD)) !== STORAGE_COST_PER_CHARACTER_NANO) {
    throw new Error(
      'billing: STORAGE_COST_PER_CHARACTER_NANO no longer matches the shared STORAGE_COST_PER_CHARACTER — update both together'
    );
  }
  if (BigInt(Math.round(byteRate * NANO_PER_USD)) !== MEDIA_STORAGE_COST_PER_BYTE_NANO) {
    throw new Error(
      'billing: MEDIA_STORAGE_COST_PER_BYTE_NANO no longer matches the shared MEDIA_STORAGE_COST_PER_BYTE — update both together'
    );
  }
}

assertStorageRatesMatchSharedFloats(STORAGE_COST_PER_CHARACTER, MEDIA_STORAGE_COST_PER_BYTE);

/**
 * Integer division with banker's rounding: midpoints go to the even
 * neighbor, everything else to the nearest. Symmetric for negatives.
 */
export function roundHalfEvenDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError('roundHalfEvenDiv: denominator must be positive');
  }
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const quotient = n / denominator;
  const remainder = n % denominator;
  const doubled = remainder * 2n;
  let rounded = quotient;
  if (doubled > denominator || (doubled === denominator && quotient % 2n === 1n)) {
    rounded = quotient + 1n;
  }
  return negative ? -rounded : rounded;
}

/**
 * The one place the customer-facing markup lands on a provider base cost.
 * Rounds half-even exactly once; callers must never re-round the result.
 */
export function applyMarkup(baseCostNanoUsd: bigint): bigint {
  if (baseCostNanoUsd < 0n) {
    throw new RangeError('applyMarkup: negative base cost is rejected, never credited');
  }
  return roundHalfEvenDiv(baseCostNanoUsd * (BASIS + MARKUP_BASIS_POINTS), BASIS);
}

const NANO_FRACTION_DIGITS = 9;
// toFixed precision for the float→decimal rendering; the digits beyond nano
// are resolved half-even below.
const RENDER_DIGITS = 12;

/**
 * Gateway float-USD → nano-USD, via the number's fixed decimal rendering so
 * no float multiplication touches the amount. Sub-nano residue rounds
 * half-even.
 */
export function usdToNanoUsd(usd: number): bigint {
  if (!Number.isFinite(usd)) {
    throw new RangeError('usdToNanoUsd: amount must be finite');
  }
  if (usd < 0) {
    throw new RangeError('usdToNanoUsd: negative amounts are rejected, never credited');
  }
  const [whole = '0', fraction = ''] = usd.toFixed(RENDER_DIGITS).split('.');
  const nanoDigits = fraction.slice(0, NANO_FRACTION_DIGITS);
  const residueDigits = fraction.slice(NANO_FRACTION_DIGITS);
  const scale = 10n ** BigInt(residueDigits.length);
  const scaled = BigInt(whole + nanoDigits + residueDigits);
  return roundHalfEvenDiv(scaled, scale);
}
