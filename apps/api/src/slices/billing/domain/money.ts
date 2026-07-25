import { MARKUP_BASIS_POINTS, TOTAL_FEE_RATE, applyMarkup, usdToNanoUsd } from '@hushbox/shared';

/**
 * Money math for the billing slice. The nano-USD `bigint` primitives
 * (`applyMarkup`, `MARKUP_BASIS_POINTS`, `roundHalfEvenDiv`, `usdToNanoUsd`)
 * and the storage nano rates are canonical in `@hushbox/shared` so client,
 * server, and shared cost paths compute over one implementation; they are
 * re-exported here so existing billing-slice callers keep importing from this
 * module unchanged. Only the markup drift guard (against the shared
 * `TOTAL_FEE_RATE` float) and the port charge conversion live here — the
 * storage rates have no float mirror to guard, since the nano value is now
 * their single source of truth.
 */
export { MARKUP_BASIS_POINTS, applyMarkup, roundHalfEvenDiv, usdToNanoUsd } from '@hushbox/shared';
export { STORAGE_COST_PER_CHARACTER_NANO, MEDIA_STORAGE_COST_PER_BYTE_NANO } from '@hushbox/shared';

/**
 * The ModelProvider port's charge conversion — the ONLY place the markup lands
 * on the money path (BILLING.md §Fee Structure; the other seam is catalog rate
 * baking at ingestion). Converts the provider's inline `usage.cost` (raw USD)
 * to the billable nano-USD amount settlement charges as-is: nano conversion
 * then the 15% markup, each rounding half-even exactly once. This composition
 * is bit-identical to the retired charge-side `applyMarkup(usdToNanoUsd(usd))`
 * — pinned so a migration can never shift a charged total. Raw provider cost
 * is never retained past this call.
 */
export function providerUsdToBillableNanoUsd(usd: number): bigint {
  return applyMarkup(usdToNanoUsd(usd));
}

/** Fail-fast guard, run at module init: the two rate constants must agree. */
export function assertMarkupMatchesSharedRate(totalFeeRate: number): void {
  if (BigInt(Math.round(totalFeeRate * 10_000)) !== MARKUP_BASIS_POINTS) {
    throw new Error(
      'billing: MARKUP_BASIS_POINTS no longer matches the shared TOTAL_FEE_RATE — update both together'
    );
  }
}

assertMarkupMatchesSharedRate(TOTAL_FEE_RATE);
