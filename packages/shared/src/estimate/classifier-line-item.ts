/**
 * The Smart-Model classifier pre-reserve as {@link NanoLineItem}s: the nano-USD,
 * input-driven successor to legacy `computeClassifierWorstCaseCents`. The
 * classifier is a bounded worst-case call — the truncated conversation context
 * plus the rendered prompt overhead as input, a fixed
 * {@link CLASSIFIER_OUTPUT_TOKEN_CAP} output — priced at the classifier model's
 * rates, split into the same marked-up-vs-storage components as a text turn:
 *
 *  - `classifier-tokens` = inputTokens × input rate + CAP × output rate.
 *    Provider cost, so it MARKS UP.
 *  - `classifier-storage` = inputChars × char rate + CAP × outputCharsPerToken ×
 *    char rate. Pass-through storage — NEVER marked up.
 *
 * The whole reserve is FIXED (nothing scales with the main turn's output), so
 * both are fixed items. `inputTokens`/`inputChars` are caller-stamped — the
 * char→token conversion stays in the tier pre-adapter — but the char count is
 * single-sourced via {@link classifierReserveChars}, and the output cap is the
 * one shared {@link CLASSIFIER_OUTPUT_TOKEN_CAP} home.
 */

import { CLASSIFIER_OUTPUT_TOKEN_CAP } from '../smart-model/eligible-models.js';
import { computeClassifierPromptOverhead } from '../smart-model/prompts.js';
import { MAX_CLASSIFIER_CONTEXT_CHARS } from '../smart-model/truncate.js';
import { STORAGE_COST_PER_CHARACTER_NANO } from './storage-rate.js';
import { estimateErr, estimateOk } from './types.js';
import type { ClassifierStage, EstimateResult, NanoLineItem } from './types.js';

/**
 * The classifier's worst-case input char count: the full truncation budget plus
 * the exact prompt overhead rendered against the candidate list (an upper bound
 * on what the classifier sees once affordability shrinks the list). Callers pass
 * this through the tier token pre-adapter to stamp `ClassifierStage.inputTokens`
 * — single-sourcing the overhead against the real prompt template.
 */
export function classifierReserveChars(
  catalog: readonly { readonly id: string; readonly description?: string }[]
): number {
  const overhead = computeClassifierPromptOverhead(
    catalog.map((entry) => ({ id: entry.id, description: entry.description ?? '' }))
  );
  return MAX_CLASSIFIER_CONTEXT_CHARS + overhead;
}

export function classifierLineItems(
  stage: ClassifierStage,
  outputCharsPerToken: number
): EstimateResult<readonly NanoLineItem[]> {
  if (stage.inputTokens < 0n) {
    return estimateErr('invalid-request', 'classifier inputTokens must be non-negative');
  }
  if (!Number.isSafeInteger(stage.inputChars) || stage.inputChars < 0) {
    return estimateErr('invalid-request', 'classifier inputChars must be a non-negative integer');
  }
  if (!Number.isSafeInteger(outputCharsPerToken) || outputCharsPerToken < 1) {
    return estimateErr(
      'invalid-request',
      'classifier outputCharsPerToken must be a positive integer'
    );
  }

  const inputRate = stage.pricing.inputPerToken;
  if (typeof inputRate !== 'bigint') {
    return estimateErr(
      'model-pricing-incomplete',
      "classifier pricing has no 'inputPerToken' rate"
    );
  }
  const outputRate = stage.pricing.outputPerToken;
  if (typeof outputRate !== 'bigint') {
    return estimateErr(
      'model-pricing-incomplete',
      "classifier pricing has no 'outputPerToken' rate"
    );
  }

  const cap = BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP);
  const providerBase = stage.inputTokens * inputRate + cap * outputRate;
  const storageBase =
    BigInt(stage.inputChars) * STORAGE_COST_PER_CHARACTER_NANO +
    cap * BigInt(outputCharsPerToken) * STORAGE_COST_PER_CHARACTER_NANO;

  return estimateOk([
    { label: 'classifier-tokens', fixedNano: providerBase, marksUp: true },
    { label: 'classifier-storage', fixedNano: storageBase, marksUp: false },
  ]);
}
