/**
 * Nano-USD money primitives: integer `bigint` end to end, banker's (half-even)
 * rounding applied exactly once. No float ever touches ledger amounts; the only
 * float input in the system is the gateway's per-generation `total_cost` USD
 * figure, converted by `usdToNanoUsd` via its decimal-string rendering.
 */

const BASIS = 10_000n;

/**
 * The 15%-over-provider-cost markup in basis points, kept as an exact bigint
 * (float rate math is banned on money). The billing slice's drift guard fails
 * fast if the shared marketing-facing `TOTAL_FEE_RATE` ever diverges from this
 * settlement constant.
 */
export const MARKUP_BASIS_POINTS = 1500n;

const NANO_FRACTION_DIGITS = 9;
// toFixed precision for the float→decimal rendering; the digits beyond nano
// are resolved half-even below.
const RENDER_DIGITS = 12;

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
 *
 * Fee-seam: this module is where fee application is DEFINED; the vendored
 * fee-seams lint rule confines importers to the sanctioned seams and matches
 * by name pattern — every fee-application helper here must keep the
 * `applyMarkup` prefix so new helpers stay covered.
 */
export function applyMarkup(baseCostNanoUsd: bigint): bigint {
  if (baseCostNanoUsd < 0n) {
    throw new RangeError('applyMarkup: negative base cost is rejected, never credited');
  }
  return roundHalfEvenDiv(baseCostNanoUsd * (BASIS + MARKUP_BASIS_POINTS), BASIS);
}

/**
 * Ceil-rounding sibling of {@link applyMarkup}: catalog rate baking rounds
 * AGAINST the user (BILLING.md §Fee Structure), so a stored billable rate is
 * never below the exact 1.15× provider rate — estimates built on it can only
 * over-reserve. Half-even stays reserved for the port's charge conversion.
 */
export function applyMarkupCeil(baseCostNanoUsd: bigint): bigint {
  if (baseCostNanoUsd < 0n) {
    throw new RangeError('applyMarkupCeil: negative base cost is rejected, never credited');
  }
  const exact = baseCostNanoUsd * (BASIS + MARKUP_BASIS_POINTS);
  return (exact + BASIS - 1n) / BASIS;
}

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
