/**
 * Premium model classification.
 *
 * Handles premium model classification and access control.
 */

import { MAX_TRIAL_MESSAGE_COST_CENTS, MINIMUM_OUTPUT_TOKENS } from '../constants.js';
import {
  estimateTokensForTier,
  outputCharsPerTokenForTier,
  priceRequest,
  reservationCeiling,
} from '../estimate/index.js';
import { usdToNanoUsd } from '../money.js';
import { NANO_USD_PER_CENT } from '../nano-usd.js';

import type { BillableRequest } from '../estimate/index.js';
import type { RawModel } from './types.js';

/** Percentile threshold for premium pricing (0.75 = 75th percentile) */
export const PREMIUM_PRICE_PERCENTILE = 0.75;

/** Recency threshold for premium models (6 months in milliseconds) */
export const PREMIUM_RECENCY_MS = 182 * 24 * 60 * 60 * 1000;

/** Model must afford at least 2× MINIMUM_OUTPUT_TOKENS within trial budget */
export const TRIAL_AFFORDABILITY_MULTIPLIER = 2;

/**
 * Check if a model is premium based on price threshold and recency.
 *
 * A model is considered premium if:
 * - Its combined price (prompt + completion) >= price threshold, OR
 * - It was released within the recency window (PREMIUM_RECENCY_MS, ~6 months)
 *
 * @param model - The raw gateway model to check
 * @param priceThreshold - The price threshold (combined prompt + completion per token)
 * @returns true if the model is premium
 */
export function isPremiumModel(model: RawModel, priceThreshold: number): boolean {
  const price =
    Number.parseFloat(model.pricing.prompt) + Number.parseFloat(model.pricing.completion);
  const recencyThreshold = Date.now() - PREMIUM_RECENCY_MS;
  return price >= priceThreshold || model.created * 1000 > recencyThreshold;
}

/**
 * Check if a model's cost exceeds the trial budget.
 * Simulates an empty user message with the given system prompt length.
 * Prices through the shared cost core (the same estimator client and server
 * use), so this never re-implements billing math.
 *
 * A model exceeds the trial budget when the worst-case cost of a turn that emits
 * `2 × MINIMUM_OUTPUT_TOKENS` — input tokens + storage + marked-up output —
 * exceeds the trial per-message cap. That worst case is exactly the core's
 * `reservationCeiling` over a single-node turn.
 *
 * @param model - The raw gateway model to check
 * @param systemPromptChars - Precomputed system prompt length (e.g. buildTurnSystemPrompt({ now }).length)
 * @returns true if the model exceeds the trial budget
 */
export function exceedsTrialBudget(model: RawModel, systemPromptChars: number): boolean {
  const request: BillableRequest = {
    models: [
      {
        pricing: {
          // Raw provider price (pre-markup) → BASE nano; the core applies markup.
          inputPerToken: usdToNanoUsd(Number.parseFloat(model.pricing.prompt)),
          outputPerToken: usdToNanoUsd(Number.parseFloat(model.pricing.completion)),
        },
      },
    ],
    inputTokens: BigInt(estimateTokensForTier('trial', systemPromptChars)),
    inputChars: systemPromptChars,
    outputCharsPerToken: outputCharsPerTokenForTier('trial'),
  };

  const manifest = priceRequest(request);
  // Rates are derived from the raw provider price and the token/char inputs are
  // always valid, so priceRequest cannot fail here; the guard is defensive
  // narrowing (fail closed as "exceeds" were it ever to fail).
  /* v8 ignore next 2 -- unreachable: valid inputs make priceRequest always succeed */
  if (!manifest.ok) return true;

  const worstCaseNanoUsd = reservationCeiling(manifest.value, {
    outputTokenCeiling: BigInt(TRIAL_AFFORDABILITY_MULTIPLIER * MINIMUM_OUTPUT_TOKENS),
    fanOutWidth: 1,
    maxSteps: 1,
    maxIterations: 1,
  });
  const trialBudgetNanoUsd = BigInt(MAX_TRIAL_MESSAGE_COST_CENTS) * NANO_USD_PER_CENT;
  return worstCaseNanoUsd > trialBudgetNanoUsd;
}
