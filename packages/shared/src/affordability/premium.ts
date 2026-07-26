/**
 * Premium model classification — one of the named structural seams of the money
 * layer (`docs/BILLING.md` §Where the Code Lives, §Model Classification).
 *
 * It lives inside the module because it compares a rate against a threshold,
 * and rate arithmetic is confined to the module. Outside it, the function had
 * to receive raw catalog rate strings and `parseFloat` them — float arithmetic
 * deciding a paid-access boundary. Taking a {@link PriceableModel}, whose rates
 * are exact nano-USD bigints, removes the reason that parse existed: the
 * comparison is now integer end to end.
 *
 * The price leg compares BILLABLE (fee-inclusive) rates against a BILLABLE
 * threshold. That is safe and requires no fee handling here, because the
 * threshold is a percentile of the same pool: scaling every rate by the same
 * factor moves the rates and the threshold together, so the classification is
 * unchanged. Fees are applied at their two seams only, never here.
 */

import { MAX_TRIAL_MESSAGE_COST_CENTS, MINIMUM_OUTPUT_TOKENS } from './constants.js';
import { estimateTokensForTier, outputCharsPerTokenForTier } from './estimate/pre-adapters.js';
import { priceRequest } from './estimate/price-request.js';
import { reservationCeiling } from './estimate/reducers.js';
import { NANO_USD_PER_CENT, nanoUSD } from './nano-usd.js';
import type { BillableRequest } from './estimate/types.js';
import type { NanoUSD } from './nano-usd.js';
import type { PriceableModel } from './priceable-model.js';

/** Combined prompt+completion rate at/above this quantile of the pool is premium. */
export const PREMIUM_PRICE_PERCENTILE = 0.75;

/** A model released within this window (~6 months) is premium on recency alone. */
export const PREMIUM_RECENCY_MS = 182 * 24 * 60 * 60 * 1000;

/** A trial-eligible model must afford at least this multiple of the minimum answer. */
export const TRIAL_AFFORDABILITY_MULTIPLIER = 2;

/**
 * The model's combined billable per-token rate — the single quantity both the
 * premium threshold and the candidate price order compare. Exact bigint
 * addition: at house-account magnitudes a float sum silently rounds, and this
 * value decides a paid-access boundary.
 */
export function combinedRateNanoUsd(model: PriceableModel): NanoUSD {
  return nanoUSD(BigInt(model.inputRateNanoUsd) + BigInt(model.outputRateNanoUsd));
}

export interface PremiumClassificationInput {
  readonly model: PriceableModel;
  /**
   * The combined billable per-token rate at/above which a model is premium —
   * the {@link PREMIUM_PRICE_PERCENTILE} of the exposed pool, resolved by the
   * caller that holds the pool.
   */
  readonly priceThresholdNanoUsd: NanoUSD;
  /** The model's release timestamp in milliseconds (catalog `releasedAt` × 1000). */
  readonly releasedAtMs: number;
  /**
   * The reference clock. An argument, not `Date.now()`: this module reads no
   * clock, so a classification is reproducible from its inputs alone.
   */
  readonly nowMs: number;
}

/**
 * Premium iff the combined billable rate is at or above the threshold, OR the
 * model was released inside {@link PREMIUM_RECENCY_MS}. Basic otherwise.
 * Classification is computed from the catalog, never stored.
 */
export function isPremiumModel(input: PremiumClassificationInput): boolean {
  const { model, priceThresholdNanoUsd, releasedAtMs, nowMs } = input;
  if (combinedRateNanoUsd(model) >= BigInt(priceThresholdNanoUsd)) return true;
  return releasedAtMs > nowMs - PREMIUM_RECENCY_MS;
}

/**
 * Whether a model's worst-case trial turn runs past the trial per-message cap.
 * The worst case is a turn that emits `TRIAL_AFFORDABILITY_MULTIPLIER ×
 * MINIMUM_OUTPUT_TOKENS` — input tokens plus output at billable rates, priced
 * through the shared estimator core, so this never re-implements billing math.
 *
 * Trial turns never persist, so the reservation is provider cost only. The
 * mechanism that drops storage is the explicit `kind === 'provider'` filter
 * below — nothing else. `inputChars: 0` drops the input-storage leg alone;
 * `output-storage` is a live line item at the trial tier's real chars-per-token
 * ratio, so removing that filter silently re-adds a storage charge to a turn
 * that never persists (§Cost, §Trial Usage).
 */
export function exceedsTrialBudget(model: PriceableModel, systemPromptChars: number): boolean {
  if (!Number.isSafeInteger(systemPromptChars) || systemPromptChars < 0) {
    throw new RangeError('exceedsTrialBudget: systemPromptChars must be a non-negative integer');
  }
  const request: BillableRequest = {
    models: [
      {
        pricing: {
          inputPerToken: BigInt(model.inputRateNanoUsd),
          outputPerToken: BigInt(model.outputRateNanoUsd),
        },
      },
    ],
    inputTokens: BigInt(estimateTokensForTier('trial', systemPromptChars)),
    inputChars: 0,
    outputCharsPerToken: outputCharsPerTokenForTier('trial'),
  };

  const manifest = priceRequest(request);
  // Both rates are present by construction (a PriceableModel carries them) and
  // the counts are validated above, so pricing cannot fail; the guard is
  // fail-closed narrowing rather than a reachable branch.
  /* v8 ignore next 2 -- unreachable: a PriceableModel always prices */
  if (!manifest.ok) return true;

  const worstCaseNanoUsd = reservationCeiling(
    { items: manifest.value.items.filter((item) => item.kind === 'provider') },
    {
      outputTokenCeiling: BigInt(TRIAL_AFFORDABILITY_MULTIPLIER * MINIMUM_OUTPUT_TOKENS),
      fanOutWidth: 1,
      maxSteps: 1,
      maxIterations: 1,
    }
  );
  return worstCaseNanoUsd > BigInt(MAX_TRIAL_MESSAGE_COST_CENTS) * NANO_USD_PER_CENT;
}
