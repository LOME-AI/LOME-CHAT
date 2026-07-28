/**
 * The Smart-Model classifier pre-reserve as a {@link NanoLineItem}: the nano-USD,
 * input-driven successor to legacy `computeClassifierWorstCaseCents`. The
 * classifier is a bounded worst-case call — the truncated conversation context
 * plus the rendered prompt overhead as input, a fixed
 * {@link CLASSIFIER_OUTPUT_TOKEN_CAP} output — priced at the classifier model's
 * rates:
 *
 *  - `classifier-tokens` = inputTokens × input rate + CAP × output rate.
 *    A provider item at BILLABLE rates.
 *
 * **There is no storage item, and its absence is the rule rather than an
 * omission.** The classifier's prompt and its answer are mid-flow values that
 * never rest, so no storage is reserved or charged for them (`docs/BILLING.md`
 * §Storage Fees, §Reasoning Effort 7, §Cost). Emitting one and filtering it out
 * downstream is how the charge came back: every reserve that folds this list in
 * would have to remember to drop it, and one of them summed the list generically.
 * Not emitting it is the only form that cannot be forgotten.
 *
 * The whole reserve is FIXED (nothing scales with the main turn's output), so it
 * is a fixed item. `inputTokens` is caller-stamped — the char→token conversion
 * stays in the tier pre-adapter — but the char count is single-sourced via
 * {@link classifierReserveChars}, and the output cap is the one shared
 * {@link CLASSIFIER_OUTPUT_TOKEN_CAP} home.
 */

import { CLASSIFIER_OUTPUT_TOKEN_CAP } from '../smart-model/eligible-models.js';
import {
  computeClassifierPromptOverhead,
  MAX_CLASSIFIER_CONTEXT_CHARS,
} from '../smart-model/prompts.js';
import { estimateErr, estimateOk } from './types.js';
import type { ClassifierStage, EstimateResult, NanoLineItem } from './types.js';

/**
 * The classifier's worst-case input char count: the truncation budget plus the
 * worst-case prompt overhead for the supplied model list. Callers pass this
 * through the tier token pre-adapter to stamp `ClassifierStage.inputTokens`.
 *
 * Both legs are upper bounds by construction rather than by measurement, which
 * is what `reserve ⊇ bill` needs of them:
 *
 * - the excerpt leg is the whole {@link MAX_CLASSIFIER_CONTEXT_CHARS} budget,
 *   and the emitter that fills it counts its own section labels and separators
 *   inside that same budget, so the message it produces never exceeds what is
 *   priced here;
 * - the template leg renders the real template with every description at its
 *   declared maximum, so no catalog text can render longer than what is priced.
 *
 * The list must be the one the classifier will be PROMPTED with. Pricing a
 * different list — the whole catalog, say — leaves the error's sign undecided
 * rather than merely generous, and an unsigned error is not a bound.
 */
export function classifierReserveChars(promptedModels: readonly { readonly id: string }[]): number {
  return MAX_CLASSIFIER_CONTEXT_CHARS + computeClassifierPromptOverhead(promptedModels);
}

export function classifierLineItems(
  stage: ClassifierStage
): EstimateResult<readonly NanoLineItem[]> {
  if (stage.inputTokens < 0n) {
    return estimateErr('invalid-request', 'classifier inputTokens must be non-negative');
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

  return estimateOk([{ label: 'classifier-tokens', fixedNano: providerBase, kind: 'provider' }]);
}
