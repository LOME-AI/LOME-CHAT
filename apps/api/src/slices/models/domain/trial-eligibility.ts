import { callBaseNanoUsd } from './estimate.js';
import type { ModelDescriptor, Pricing } from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The trial send gate: three pre-run refusals that keep the free trial to
 * cheap text models. It replicates the legacy behavior (premium price
 * percentile + recency, per-model affordability, and non-text blocking) freshly
 * in integer nano-USD; no legacy code is imported.
 *
 * Cost basis, stated once (see also the route): every comparison against the 1¢
 * cap uses the BASE (pre-markup) provider cost from `callBaseNanoUsd`, never a
 * marked-up figure and never the worst-case run ceiling. Base is what the
 * provider charges us, which is the amount the trial's spend cap is protecting.
 */

/** Combined price at/above this quartile of the exposed text catalog is premium. */
const TRIAL_PRICE_PERCENTILE = 0.75;

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

/** Conservative chars-per-token ratio for the per-message estimate. Low ratio =
 * more tokens = a deliberate overestimate (the trial absorbs any overrun). */
const TRIAL_CHARS_PER_TOKEN = 2;

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
function isTextModel(descriptor: ModelDescriptor): boolean {
  return (
    descriptor.inputs.includes('text') &&
    descriptor.outputs.length === 1 &&
    descriptor.outputs[0] === 'text'
  );
}

/** A flat per-token rate as a bigint, or 0n when absent or a matrix rate. */
function flatRate(pricing: Pricing, key: string): bigint {
  const rate = pricing[key];
  return typeof rate === 'bigint' ? rate : 0n;
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
 * for an empty text catalog (no threshold, so the percentile leg never fires).
 * Non-text models are excluded from the distribution.
 */
export function trialPriceThresholdNanoUsd(
  exposedCatalog: readonly ModelDescriptor[]
): bigint | undefined {
  const prices = exposedCatalog
    .filter((descriptor) => isTextModel(descriptor))
    .map((descriptor) => combinedBasePrice(descriptor.pricing))
    .toSorted(ascending);
  if (prices.length === 0) return undefined;
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
 * The BASE (pre-markup) cost of the ACTUAL trial message on a minimum basis:
 * the prompt's estimated input tokens plus a fixed minimum output allocation
 * (2000 tokens) — NOT the worst-case run ceiling. The route refuses the send
 * when this exceeds `TRIAL_MESSAGE_COST_CAP_NANO_USD`.
 */
export function trialMessageBaseNanoUsd(
  target: ModelDescriptor,
  promptText: string
): Result<bigint, DomainError> {
  const inputTokens = Math.ceil(promptText.length / TRIAL_CHARS_PER_TOKEN);
  return callBaseNanoUsd(target.pricing, {
    kind: 'tokens',
    inputTokens,
    outputTokens: AFFORDABILITY_OUTPUT_TOKENS,
  });
}
