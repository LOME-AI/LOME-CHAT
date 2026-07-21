/**
 * Customer-facing price DISPLAY formatters over the canonical nano-USD wire.
 *
 * The wire (`WireModelPricing`) carries BASE, pre-markup nano-USD rates, so every
 * price shown to a customer must have the 15% markup applied first — these are the
 * one place display does that, via {@link applyMarkup}. All money arithmetic stays
 * in integer `bigint`; a value is only rendered to a human-readable dollar STRING
 * at the very end (never float money math).
 */

import { EXPENSIVE_MODEL_THRESHOLD_PER_1K } from '../constants.js';
import { applyMarkup, roundHalfEvenDiv, usdToNanoUsd } from '../money.js';
import { nanoUsdToFullDollarString } from '../nano-usd.js';

/** Tokens per "per-1k" display unit. */
const TOKENS_PER_DISPLAY_UNIT = 1000n;

/** Nano fractional digits in a full-precision dollar string (`X.fffffffff`). */
const NANO_FRACTION_DIGITS = 9;

/**
 * The expensive-model warning threshold in nano-USD per 1k tokens, derived once
 * from the single canonical `EXPENSIVE_MODEL_THRESHOLD_PER_1K` USD constant — not
 * mirrored — so the display comparison stays in exact integer nano.
 */
const EXPENSIVE_MODEL_THRESHOLD_PER_1K_NANO = usdToNanoUsd(EXPENSIVE_MODEL_THRESHOLD_PER_1K);

/** A non-negative nano bigint as `$X` with trailing zeros (and a bare dot) stripped. */
function strippedDollars(nano: bigint): string {
  const bare = nanoUsdToFullDollarString(nano.toString());
  const stripped = bare.replace(/\.?0+$/, '');
  return `$${stripped}`;
}

/** A non-negative nano bigint as `$X.d…` with exactly `fractionDigits` decimals, half-even. */
function fixedDollars(nano: bigint, fractionDigits: number): string {
  const scale = 10n ** BigInt(NANO_FRACTION_DIGITS - fractionDigits);
  const units = roundHalfEvenDiv(nano, scale);
  const divisor = 10n ** BigInt(fractionDigits);
  const whole = units / divisor;
  const fraction = units % divisor;
  return `$${whole.toString()}.${fraction.toString().padStart(fractionDigits, '0')}`;
}

/**
 * Marked-up customer price for 1,000 tokens of a BASE per-token nano rate,
 * rendered `$X` with trailing zeros stripped (e.g. `$0.00115`). Mirrors the legacy
 * `formatPricePer1k`, but takes a BASE nano rate and applies the markup here.
 */
export function nanoPricePer1k(baseNanoPerToken: bigint): string {
  return strippedDollars(applyMarkup(baseNanoPerToken * TOKENS_PER_DISPLAY_UNIT));
}

/**
 * Marked-up customer price-RANGE per 1k tokens for the Smart-Model min/max pool
 * bounds (e.g. `$0.00115 – $0.0023 / 1k`). Both bounds are BASE nano rates.
 */
export function nanoPriceRangePer1k(
  minBaseNanoPerToken: bigint,
  maxBaseNanoPerToken: bigint
): string {
  return `${nanoPricePer1k(minBaseNanoPerToken)} – ${nanoPricePer1k(maxBaseNanoPerToken)} / 1k`;
}

/**
 * Whether a text model's marked-up combined (input + output) cost per 1k tokens
 * reaches the expensive-model warning threshold ($0.10). Inputs are BASE nano
 * per-token rates; the markup applies once to the combined per-1k subtotal.
 */
export function isExpensiveModelNano(
  baseInputNanoPerToken: bigint,
  baseOutputNanoPerToken: bigint
): boolean {
  const combinedPer1k = (baseInputNanoPerToken + baseOutputNanoPerToken) * TOKENS_PER_DISPLAY_UNIT;
  return applyMarkup(combinedPer1k) >= EXPENSIVE_MODEL_THRESHOLD_PER_1K_NANO;
}

/**
 * Marked-up customer price for a single BASE nano unit rate (per-image or
 * per-second), rendered `$X.d…` at a fixed decimal precision (`fractionDigits`
 * ≤ 9). Used by the per-image and per-second media displays.
 */
export function nanoUnitPriceUsd(baseNano: bigint, fractionDigits: number): string {
  return fixedDollars(applyMarkup(baseNano), fractionDigits);
}
