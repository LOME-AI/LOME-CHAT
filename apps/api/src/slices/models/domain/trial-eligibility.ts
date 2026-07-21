import {
  estimateTokensForTier,
  evaluateManifest,
  isRunnableModelShape,
  outputCharsPerTokenForTier,
  priceRequest,
} from '@hushbox/shared';
import { callBaseNanoUsd, ratesFromPricing } from './estimate.js';
import { validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { ChatHistoryMessage, ModelDescriptor, Pricing } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The trial send gate: three pre-run refusals that keep the free trial to
 * cheap text models — the premium gate (price percentile + release recency),
 * per-model affordability against the 1¢ cap, and non-text blocking — all
 * computed in integer nano-USD.
 *
 * Cost basis, stated once (see also the route): the 1¢ cap compares PRE-MARKUP
 * cost — never a marked-up figure and never the worst-case run ceiling. The
 * per-send budget (`trialMessageBaseNanoUsd`) is the provider base PLUS the
 * pass-through R2 storage the send will incur (legacy `calculateTrialBudget`
 * included storage), storage being pre-markup by construction (it never marks
 * up). The coarse premium-classification leg (`exceedsMinimalAffordability`)
 * stays provider-base only: it is a token-count heuristic over a fixed synthetic
 * exchange, with no real character count to size storage against.
 */

/** Combined price at/above this quartile of the exposed text catalog is premium. */
const TRIAL_PRICE_PERCENTILE = 0.75;

/** A quartile is only meaningful over a real sample; below this many priceable
 * text models the percentile leg is skipped (it would degenerate — e.g. a
 * single-model catalog marks its one model premium against itself). Recency and
 * affordability still guard. */
const TRIAL_MIN_TEXT_MODELS_FOR_PERCENTILE = 4;

/** A model released within this window (~6 months) is premium. */
const TRIAL_RECENCY_MS = 182 * 24 * 60 * 60 * 1000;

/** The minimal exchange reserves this multiple of the min output tokens. */
const TRIAL_AFFORDABILITY_OUTPUT_MULTIPLIER = 2;

/** Output tokens a minimal trial exchange is sized to afford. */
const TRIAL_MIN_OUTPUT_TOKENS = 1000;

/** 1¢ in nano-USD (0.01 USD). The per-message and affordability caps compare
 * BASE (pre-markup) cost against this. */
export const TRIAL_MESSAGE_COST_CAP_NANO_USD = 10_000_000n;

/** A fixed, coarse system-prompt input-token estimate for the model-level
 * affordability leg. The 2000 output tokens dominate the estimate, so the exact
 * input figure is not load-bearing; it stands in for the base system prompt. */
const TRIAL_MINIMAL_INPUT_TOKENS = 500;

/** Output tokens both the affordability leg and the per-message cap price. */
const AFFORDABILITY_OUTPUT_TOKENS = TRIAL_AFFORDABILITY_OUTPUT_MULTIPLIER * TRIAL_MIN_OUTPUT_TOKENS;

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

/** A flat per-token rate as a bigint, or 0n when absent or a matrix rate. */
function flatRate(pricing: Pricing, key: string): bigint {
  const rate = pricing[key];
  return typeof rate === 'bigint' ? rate : 0n;
}

/**
 * A model is priceable for trial iff it carries BOTH plain per-token rates as
 * bigints — exactly what `callBaseNanoUsd({kind:'tokens'})` requires to price a
 * token exchange. A model missing either rate (e.g. priced only on
 * `cachedInputPerToken`) would error mid-send; refusing it at the gate turns
 * that crash into a clean `PREMIUM_REQUIRES_ACCOUNT` refusal (exclusion at
 * exposure), and keeps un-priceable models out of the percentile distribution.
 */
function isPriceableForTrial(pricing: Pricing): boolean {
  return (
    typeof pricing['inputPerToken'] === 'bigint' && typeof pricing['outputPerToken'] === 'bigint'
  );
}

/** input + output per-token base rates — the price the percentile ranks on. */
function combinedBasePrice(pricing: Pricing): bigint {
  return flatRate(pricing, 'inputPerToken') + flatRate(pricing, 'outputPerToken');
}

function ascending(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The premium price threshold: the combined base price at position
 * floor(len * 0.75) of the exposed text catalog, sorted ascending. `undefined`
 * when fewer than {@link TRIAL_MIN_TEXT_MODELS_FOR_PERCENTILE} priceable text
 * models exist (no threshold, so the percentile leg never fires — it would
 * degenerate on a tiny sample). Non-text and un-priceable models are excluded
 * from the distribution.
 */
export function trialPriceThresholdNanoUsd(
  exposedCatalog: readonly ModelDescriptor[]
): bigint | undefined {
  const prices = exposedCatalog
    .filter((descriptor) => isTextModel(descriptor) && isPriceableForTrial(descriptor.pricing))
    .map((descriptor) => combinedBasePrice(descriptor.pricing))
    .toSorted(ascending);
  if (prices.length < TRIAL_MIN_TEXT_MODELS_FOR_PERCENTILE) return undefined;
  return prices[Math.floor(prices.length * TRIAL_PRICE_PERCENTILE)];
}

/** releasedAt is UNIX SECONDS; recent iff its ms form is within the window. */
function isRecent(releasedAtSeconds: number, nowMs: number): boolean {
  return releasedAtSeconds * 1000 > nowMs - TRIAL_RECENCY_MS;
}

/** The minimal representative exchange's base cost exceeds the 1¢ cap. An
 * un-priceable minimal exchange (missing rates) is treated as not-exceeded —
 * the percentile and recency legs still guard. */
function exceedsMinimalAffordability(pricing: Pricing): boolean {
  const base = callBaseNanoUsd(pricing, {
    kind: 'tokens',
    inputTokens: TRIAL_MINIMAL_INPUT_TOKENS,
    outputTokens: AFFORDABILITY_OUTPUT_TOKENS,
  }).unwrapOr(0n);
  return base > TRIAL_MESSAGE_COST_CAP_NANO_USD;
}

/**
 * The single source for whether a model may be used on the free trial. Blocks
 * non-text models first, then premium models (top price quartile OR recent
 * release OR a minimal exchange over the 1¢ cap). `exposedCatalog` is the full
 * exposed catalog (from `listDescriptors`); the percentile is taken over its
 * text subset. `nowMs` is the reference clock for recency.
 */
export function trialEligibility(
  target: ModelDescriptor,
  exposedCatalog: readonly ModelDescriptor[],
  nowMs: number
): TrialEligibility {
  if (!isTextModel(target)) return { eligible: false, reason: 'non-text' };
  // Un-priceable for trial (missing a plain per-token rate) is refused at the
  // gate as premium — sending it would error mid-pricing.
  if (!isPriceableForTrial(target.pricing)) return { eligible: false, reason: 'premium' };

  const threshold = trialPriceThresholdNanoUsd(exposedCatalog);
  const topQuartile = threshold !== undefined && combinedBasePrice(target.pricing) >= threshold;

  if (
    topQuartile ||
    isRecent(target.releasedAt, nowMs) ||
    exceedsMinimalAffordability(target.pricing)
  ) {
    return { eligible: false, reason: 'premium' };
  }
  return { eligible: true };
}

/**
 * The pre-markup cost of the ACTUAL trial message on a minimum basis: the FULL
 * input the model will see — every history message's content plus the prompt —
 * estimated as input tokens, its input STORAGE, a fixed minimum output
 * allocation (2000 tokens), and that output's STORAGE; NOT the worst-case run
 * ceiling. Priced through the shared core (`priceRequest`, trial tier) so the
 * cost formula lives once. The route refuses the send when this exceeds
 * `TRIAL_MESSAGE_COST_CAP_NANO_USD` — a long resent history legitimately trips
 * the cap (it is the honest cost of the send, storage included).
 */
export function trialMessageBaseNanoUsd(
  target: ModelDescriptor,
  promptText: string,
  history: readonly ChatHistoryMessage[]
): Result<bigint, DomainError> {
  const historyChars = history.reduce((total, message) => total + message.content.length, 0);
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
  return ok(evaluateManifest(priced.value, BigInt(AFFORDABILITY_OUTPUT_TOKENS), { marksUpOnly: false }));
}
