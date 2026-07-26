/**
 * Catalog admission's commercial rules (`docs/BILLING.md` §Catalog Admission):
 * the price floor, the age cutoff, and the top-context exemption that bypasses
 * both. Ingestion applies them; they live here because they are rate
 * arithmetic, which is confined to this module, and because the floor is
 * load-bearing beyond the catalog — the classifier engine is the cheapest
 * priceable model, so without a floor under "cheapest" the classifier reserve
 * collapses to zero.
 *
 * Every rate here is PRE-FEE. The floor is a margin floor, so the raw provider
 * rate is the quantity that decides whether a percentage of it is worth having.
 */
import {
  MAX_MODEL_AGE_MS,
  MIN_PRICE_PER_1K_TOKENS_NANO,
  TOP_CONTEXT_PERCENTILE,
} from './constants.js';

/** The floor is stated per 1,000 tokens; catalog rates are per single token. */
const FLOOR_TOKEN_BASIS = 1000n;

/** `zero` earns nothing and is excluded unconditionally — no exemption applies
 * to it — so it is a verdict of its own rather than a degenerate `below-floor`. */
export type PriceFloorVerdict = 'zero' | 'below-floor' | 'meets-floor';

/**
 * The price-floor verdict for one model, over its PRE-FEE combined rate. Both
 * legs are nano-USD per token; a leg the gateway states no rate for is zero,
 * because a model that names no rate charges nothing for it.
 */
export function priceFloorVerdict(
  inputRateNanoPerToken: bigint,
  outputRateNanoPerToken: bigint
): PriceFloorVerdict {
  const combined = inputRateNanoPerToken + outputRateNanoPerToken;
  if (combined === 0n) return 'zero';
  return combined * FLOOR_TOKEN_BASIS < MIN_PRICE_PER_1K_TOKENS_NANO
    ? 'below-floor'
    : 'meets-floor';
}

/**
 * Whether a model's release date sits further back than the age cutoff.
 * `releasedAtSeconds` is UNIX SECONDS (OpenRouter's `created`); `nowMs` is the
 * ingesting caller's clock, injected so admission stays a pure function.
 */
export function exceedsModelAgeLimit(releasedAtSeconds: number, nowMs: number): boolean {
  return releasedAtSeconds * 1000 < nowMs - MAX_MODEL_AGE_MS;
}

/**
 * The context length at or above which a model is exempt from the price floor
 * and the age cutoff: the {@link TOP_CONTEXT_PERCENTILE} percentile of the
 * pool's context lengths.
 *
 * The pool is a property of the catalog, never of a payer or a prompt, so the
 * exemption set is reproducible from the catalog alone. Ties are inclusive —
 * models sharing the threshold length are all exempt — so a pool with a flat
 * top exempts more than 5% by count, which is the honest reading of "top
 * context length" and keeps the answer independent of row order. An empty pool
 * yields 0, which exempts everything; that is only reachable when there is
 * nothing to admit.
 */
export function topContextExemptionTokens(contextLengths: readonly number[]): number {
  const sorted = [...contextLengths].toSorted((a, b) => a - b);
  const index = Math.min(Math.floor(sorted.length * TOP_CONTEXT_PERCENTILE), sorted.length - 1);
  return sorted[index] ?? 0;
}
