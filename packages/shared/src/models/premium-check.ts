/**
 * Premium model classification.
 *
 * Handles premium model classification and access control.
 */

import { calculateBudget } from '../budget.js';
import { MAX_TRIAL_MESSAGE_COST_CENTS, MINIMUM_OUTPUT_TOKENS } from '../constants.js';
import { applyFees } from '../pricing.js';

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
 * Reuses calculateBudget() to avoid duplicating billing math.
 *
 * A model exceeds the trial budget when:
 *   estimatedInputCost + (2 × MINIMUM_OUTPUT_TOKENS × outputCostPerToken) > trialBudget
 *
 * @param model - The raw gateway model to check
 * @param systemPromptChars - Precomputed system prompt length (e.g. buildSystemPrompt([]).length)
 * @returns true if the model exceeds the trial budget
 */
export function exceedsTrialBudget(model: RawModel, systemPromptChars: number): boolean {
  const result = calculateBudget({
    tier: 'trial',
    balanceCents: 0,
    freeAllowanceCents: 0,
    promptCharacterCount: systemPromptChars,
    models: [
      {
        modelInputPricePerToken: applyFees(Number.parseFloat(model.pricing.prompt)),
        modelOutputPricePerToken: applyFees(Number.parseFloat(model.pricing.completion)),
        contextLength: model.context_length,
      },
    ],
  });

  const trialBudget = MAX_TRIAL_MESSAGE_COST_CENTS / 100;
  const requiredOutputCost =
    TRIAL_AFFORDABILITY_MULTIPLIER * MINIMUM_OUTPUT_TOKENS * result.outputCostPerToken;
  return result.estimatedInputCost + requiredOutputCost > trialBudget;
}
