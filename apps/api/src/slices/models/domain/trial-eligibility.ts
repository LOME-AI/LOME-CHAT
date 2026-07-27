import { historyCharacterCount, isRunnableModelShape } from '@hushbox/shared';
import {
  exceedsTrialBudget,
  isPremiumModel,
  premiumPriceThresholdNanoUsd,
  priceableModelFrom,
} from '@hushbox/shared/affordability';
import {
  estimateTokensForTier,
  outputCharsPerTokenForTier,
} from '@hushbox/shared/affordability/estimate/pre-adapters';
import { priceRequest } from '@hushbox/shared/affordability/estimate/price-request';
import { evaluateManifest } from '@hushbox/shared/affordability/estimate/reducers';
import { ratesFromPricing } from './estimate.js';
import { validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { ChatHistoryMessage, ModelDescriptor } from '@hushbox/shared';
import type { PriceableModel } from '@hushbox/shared/affordability';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The trial send gate: three pre-run refusals that keep the free trial to
 * cheap text models — the premium gate, per-model affordability against the 1¢
 * cap, and non-text blocking — all computed in integer nano-USD.
 *
 * Every classification rule is the money layer's: the price percentile, the
 * recency window and the minimal-exchange affordability leg are
 * `premiumPriceThresholdNanoUsd`, `isPremiumModel` and `exceedsTrialBudget`. This
 * file contributes the trial's own two facts — what counts as a TEXT model, and
 * what the per-message cap prices — and nothing about premium.
 *
 * Cost basis, stated once (see also the route): the 1¢ cap compares BILLABLE
 * cost — the same figure a paid send would be charged, never the worst-case run
 * ceiling. The two legs price different bases deliberately. The MODEL-level leg
 * is provider-only over a fixed synthetic exchange, because a trial turn never
 * persists (§Trial Usage). The per-send budget (`trialMessageBillableNanoUsd`)
 * still prices the pass-through storage of the send; §Trial Usage says a trial
 * turn stores nothing, so that term does not belong there either — it is left in
 * place deliberately, because removing it narrows the margin between this gate
 * and the compiled turn's own floor to less than the system-prompt input tokens
 * this gate does not price, and the gate must dominate that floor for every rate
 * shape.
 */

/** 1¢ in nano-USD (0.01 USD). The per-message cap compares BILLABLE (all-in)
 * cost against this. */
export const TRIAL_MESSAGE_COST_CAP_NANO_USD = 10_000_000n;

/** Output tokens the per-message cap prices. */
const AFFORDABILITY_OUTPUT_TOKENS = 2000;

/**
 * The coarse prompt-character basis the MODEL-level classification leg prices
 * its minimal exchange over. A fixed figure, not the turn's real prompt: this
 * leg answers "may this model ever be used on trial", which must not move with
 * what a user typed. At the trial tier's 2 chars-per-token ratio it is the 500
 * input tokens that leg has always priced, and the 2,000 output tokens dominate
 * it either way.
 */
const TRIAL_CLASSIFICATION_PROMPT_CHARS = 1000;

export type TrialEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: 'non-text' | 'premium' };

/**
 * A model is text for trial purposes iff it accepts text input and produces text
 * and ONLY text. The output gate is strictly text-only — not merely "output
 * call-shape is the language family," which admits any output list containing
 * text (e.g. text+image). Being strict here makes the trial gate
 * self-sufficiently fail-closed: a text+media model is refused at the gate with
 * the friendly MEDIA_TRIAL_BLOCKED, so trial safety does not depend on the
 * engine's single-modality build limit that independently refuses multi-output
 * models later with a generic 400.
 */
export function isTextModel(descriptor: ModelDescriptor): boolean {
  return isRunnableModelShape(descriptor) && descriptor.outputs[0] === 'text';
}

/**
 * The priceable text pool the premium percentile is taken over: text models the
 * money layer can project. Being projectable IS membership in §Predicates'
 * priceable catalog pool, so a model missing a per-token rate or a context length
 * is out of the distribution — and, as a target, refused at the gate rather than
 * left to error mid-send.
 */
function priceableTextPool(exposedCatalog: readonly ModelDescriptor[]): readonly PriceableModel[] {
  return exposedCatalog
    .filter((descriptor) => isTextModel(descriptor))
    .flatMap((descriptor) => {
      const model = priceableModelFrom(descriptor);
      return model === undefined ? [] : [model];
    });
}

/**
 * The single source for whether a model may be used on the free trial. Blocks
 * non-text models first, then premium models. `exposedCatalog` is the full
 * exposed catalog (from `listDescriptors`); the percentile is taken over its
 * priceable text subset. `nowMs` is the reference clock for recency.
 *
 * Both premium legs and the trial affordability leg are the money layer's own
 * (`isPremiumModel`, `premiumPriceThresholdNanoUsd`, `exceedsTrialBudget`): the
 * percentile and the recency window exist ONCE, inside the module, so this gate
 * and every other premium surface cannot drift apart.
 */
export function trialEligibility(
  target: ModelDescriptor,
  exposedCatalog: readonly ModelDescriptor[],
  nowMs: number
): TrialEligibility {
  if (!isTextModel(target)) return { eligible: false, reason: 'non-text' };
  const model = priceableModelFrom(target);
  // Un-priceable (no plain per-token rate, or no context length) is refused at
  // the gate as premium — sending it would error mid-pricing.
  if (model === undefined) return { eligible: false, reason: 'premium' };

  const threshold = premiumPriceThresholdNanoUsd(priceableTextPool(exposedCatalog));
  const premium = isPremiumModel({
    model,
    ...(threshold === undefined ? {} : { priceThresholdNanoUsd: threshold }),
    // `releasedAt` is UNIX SECONDS; the classifier takes milliseconds.
    releasedAtMs: target.releasedAt * 1000,
    nowMs,
  });

  if (premium || exceedsTrialBudget(model, TRIAL_CLASSIFICATION_PROMPT_CHARS)) {
    return { eligible: false, reason: 'premium' };
  }
  return { eligible: true };
}

/**
 * The BILLABLE cost of the ACTUAL trial message on a minimum basis: the FULL
 * input the model will see — every history message's content plus the prompt —
 * estimated as input tokens, its input STORAGE, a fixed minimum output
 * allocation (2000 tokens), and that output's STORAGE; NOT the worst-case run
 * ceiling. Priced through the shared core (`priceRequest`, trial tier) so the
 * cost formula lives once. The route refuses the send when this exceeds
 * `TRIAL_MESSAGE_COST_CAP_NANO_USD` — a long resent history legitimately trips
 * the cap (it is the honest cost of the send, storage included).
 */
export function trialMessageBillableNanoUsd(
  target: ModelDescriptor,
  promptText: string,
  history: readonly ChatHistoryMessage[]
): Result<bigint, DomainError> {
  const historyChars = historyCharacterCount(history);
  const inputChars = historyChars + promptText.length;
  // Conservative ratio (2 chars/token, a deliberate overestimate the trial absorbs)
  // comes from the shared helper: every non-paid tier selects it.
  const inputTokens = BigInt(estimateTokensForTier('trial', inputChars));
  const priced = priceRequest({
    models: [{ pricing: ratesFromPricing(target.pricing) }],
    inputTokens,
    inputChars,
    outputCharsPerToken: outputCharsPerTokenForTier('trial'),
  });
  if (!priced.ok) return err(validationError(priced.error.detail));
  return ok(
    evaluateManifest(priced.value, BigInt(AFFORDABILITY_OUTPUT_TOKENS), { scope: 'all-in' })
  );
}
