import {
  TOTAL_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
  MEDIA_STORAGE_COST_PER_BYTE,
  EXPENSIVE_MODEL_THRESHOLD_PER_1K,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
  MAX_SEARCH_TOOL_CALLS,
  SEARCH_COST_PER_CALL,
} from './constants.js';
import { assertNever } from './utils/assert-never.js';
import type { UserTier } from './tiers.js';

/**
 * Parse a price string from the AI Gateway model metadata. Works for any
 * price field — per-token, per-image, or per-second — despite the historical
 * name. Returns 0 for negative sentinel values (e.g. "-1" = "variable pricing")
 * and for NaN/missing values.
 */
export function parseTokenPrice(raw: string): number {
  const value = Number.parseFloat(raw);
  return Number.isNaN(value) || value < 0 ? 0 : value;
}

/**
 * Estimate token count from text using character-based heuristic.
 * Uses ~4 characters per token approximation.
 * This is an approximation - actual tokenization varies by model.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Apply all fees to a base price.
 * SINGLE SOURCE OF TRUTH for fee application.
 *
 * Reserved for prices that don't come from a `Model` / `ModelInfo`. As of the
 * `processModels` / `pricingFromRawModel` boundary, every `Model.pricePer*`
 * and `ModelInfo.pricing.*` field is already fee-inclusive — wrapping those
 * in `applyFees(...)` would double-apply. Legitimate callers today:
 *   - `calculateMessageCostFromActual(gatewayCost)` — raw gateway response
 *   - `worstCaseSearchCost()` — raw constants
 *   - `estimateMessageCostDevelopment({...webSearchCost})` — raw constant
 *   - `cost-calculator.ts` stage breakdown — raw `gatewayCost`
 *   - `lookupModelPricing` in stream-pipeline — converts RawModel to ModelPricingResult
 *
 * The total fee rate is the sum of every non-zero category in FEE_CATEGORIES
 * (see `./fees.ts`). Setting any individual rate to 0 cascades through every
 * pricing surface automatically.
 */
export function applyFees(basePrice: number): number {
  return basePrice * (1 + TOTAL_FEE_RATE);
}

/**
 * Calculate token cost. Inputs are fee-inclusive per-token prices (as returned
 * from `processModels()`); the result is the fee-inclusive token cost — fees
 * are not re-applied here.
 */
export function calculateTokenCost(
  inputTokens: number,
  outputTokens: number,
  pricePerInputToken: number,
  pricePerOutputToken: number
): number {
  return inputTokens * pricePerInputToken + outputTokens * pricePerOutputToken;
}

export interface MessageCostParams {
  /** Tokens used for input (from the AI Gateway) */
  inputTokens: number;
  /** Tokens used for output (from the AI Gateway) */
  outputTokens: number;
  /** Characters in user message */
  inputCharacters: number;
  /** Characters in AI response */
  outputCharacters: number;
  /** Model's price per input token in USD */
  pricePerInputToken: number;
  /** Model's price per output token in USD */
  pricePerOutputToken: number;
  /** Per-search cost in USD (base price, fees will be applied). 0 or omitted if no search. */
  webSearchCost?: number;
}

/**
 * Estimate message cost for development environment using token counts.
 *
 * Use this when exact AI Gateway generation stats are not available (local development).
 * For production, use calculateMessageCostFromActual with exact costs.
 *
 * Inputs `pricePerInputToken` and `pricePerOutputToken` are fee-inclusive per-token
 * prices (as returned from `processModels()`); `webSearchCost` is a raw constant,
 * so fees are applied to it here.
 *
 * Components:
 * 1. Token cost (fee-inclusive, already includes markup) via calculateTokenCost
 * 2. Storage fee: (inputCharacters + outputCharacters) × STORAGE_COST_PER_CHARACTER
 * 3. Web search: applyFees(webSearchCost)
 *
 * Storage fee applies only to new messages (input + output), not conversation history.
 * Fees apply only to model cost (and web search), not to the storage fee.
 */
export function estimateMessageCostDevelopment(params: MessageCostParams): number {
  const {
    inputTokens,
    outputTokens,
    inputCharacters,
    outputCharacters,
    pricePerInputToken,
    pricePerOutputToken,
    webSearchCost = 0,
  } = params;

  const tokenCost = calculateTokenCost(
    inputTokens,
    outputTokens,
    pricePerInputToken,
    pricePerOutputToken
  );

  const storageFee = (inputCharacters + outputCharacters) * STORAGE_COST_PER_CHARACTER;

  return tokenCost + storageFee + applyFees(webSearchCost);
}

export interface MessageCostFromActualParams {
  /** Exact cost in USD from OpenRouter's authoritative inline `usage.cost` */
  gatewayCost: number;
  /** Characters in user message */
  inputCharacters: number;
  /** Characters in AI response */
  outputCharacters: number;
}

/**
 * Calculate message cost using the AI gateway's exact cost.
 * SINGLE SOURCE OF TRUTH for billing based on actual usage.
 *
 * The gateway's totalCost includes any web search tool calls, caching discounts,
 * and tiered pricing. This function adds HushBox fees and storage cost on top.
 *
 * Components:
 * 1. Model cost with fees: gatewayCost × (1 + TOTAL_FEE_RATE)
 * 2. Storage fee: (inputCharacters + outputCharacters) × STORAGE_COST_PER_CHARACTER
 */
export function calculateMessageCostFromActual(params: MessageCostFromActualParams): number {
  const { gatewayCost, inputCharacters, outputCharacters } = params;

  const modelCostWithFees = applyFees(gatewayCost);

  const storageFee = (inputCharacters + outputCharacters) * STORAGE_COST_PER_CHARACTER;

  return modelCostWithFees + storageFee;
}

/**
 * Get combined model cost per 1k tokens. Inputs are fee-inclusive per-token
 * prices (as returned from `processModels()`); the result is fee-inclusive
 * combined cost per 1k tokens.
 *
 * Used by:
 * - Model selector for sorting
 * - isExpensiveModel() check
 * - Any UI showing combined model cost
 *
 * @param pricePerInputToken - Model's fee-inclusive price per input token in USD
 * @param pricePerOutputToken - Model's fee-inclusive price per output token in USD
 * @returns Combined cost per 1k tokens, fee-inclusive
 */
export function getModelCostPer1k(pricePerInputToken: number, pricePerOutputToken: number): number {
  return (pricePerInputToken + pricePerOutputToken) * 1000;
}

/**
 * Check if a model is considered expensive (>= threshold per 1k tokens).
 * Threshold and inputs are both fee-inclusive.
 *
 * @param pricePerInputToken - Model's fee-inclusive price per input token in USD
 * @param pricePerOutputToken - Model's fee-inclusive price per output token in USD
 * @returns true if model cost per 1k >= EXPENSIVE_MODEL_THRESHOLD_PER_1K
 */
export function isExpensiveModel(pricePerInputToken: number, pricePerOutputToken: number): boolean {
  return (
    getModelCostPer1k(pricePerInputToken, pricePerOutputToken) >= EXPENSIVE_MODEL_THRESHOLD_PER_1K
  );
}

/**
 * Pricing tuple consumed by budget calculations. Both per-token prices are
 * fee-inclusive (`Model.pricePer*` already includes fees as of `processModels`).
 */
export interface ModelPricingResult {
  inputPricePerToken: number;
  outputPricePerToken: number;
  contextLength: number;
}

/**
 * Effective cost per output token: model cost + estimated storage cost.
 *
 * Output is tokens→chars: INVERTED from input (chars→tokens).
 * Free/trial/guest: STANDARD (4 chars/tok) → pessimistic (more storage budgeted).
 * Paid: CONSERVATIVE (2 chars/tok) → optimistic (less storage, cushion absorbs overruns).
 */
export function effectiveOutputCostPerToken(
  modelOutputPricePerToken: number,
  tier: UserTier
): number {
  const outputCharsPerToken =
    tier === 'paid' ? CHARS_PER_TOKEN_CONSERVATIVE : CHARS_PER_TOKEN_STANDARD;
  const storageCostPerToken = outputCharsPerToken * STORAGE_COST_PER_CHARACTER;
  return modelOutputPricePerToken + storageCostPerToken;
}

/**
 * Storage cost for media bytes (R2 + backup, 50-year retention).
 * Used by both pre-inference budget reservation and post-inference billing.
 */
export function mediaStorageCost(sizeBytes: number): number {
  return sizeBytes * MEDIA_STORAGE_COST_PER_BYTE;
}

export type MediaPricing =
  | { kind: 'image'; perImage: number }
  | { kind: 'audio'; perSecond: number }
  | { kind: 'video'; perSecond: number };

export interface CalculateMediaGenerationCostParams {
  pricing: MediaPricing;
  sizeBytes: number;
  imageCount?: number;
  durationSeconds?: number;
}

/**
 * Calculate the final billable cost for a media generation.
 * Deterministic — no gateway call needed. Inputs are fee-inclusive
 * per-unit prices (as carried by `ModelInfo.pricing` / `Model.pricePer*`);
 * storage cost is additive (no fee on storage).
 */
export function calculateMediaGenerationCost(params: CalculateMediaGenerationCostParams): number {
  const { pricing, sizeBytes, imageCount, durationSeconds } = params;
  const storage = mediaStorageCost(sizeBytes);

  switch (pricing.kind) {
    case 'image': {
      const count = imageCount ?? 1;
      return pricing.perImage * count + storage;
    }
    case 'video': {
      if (durationSeconds === undefined)
        throw new Error('durationSeconds required for video pricing');
      return pricing.perSecond * durationSeconds + storage;
    }
    case 'audio': {
      if (durationSeconds === undefined)
        throw new Error('durationSeconds required for audio pricing');
      return pricing.perSecond * durationSeconds + storage;
    }
    default: {
      return assertNever(pricing);
    }
  }
}

/**
 * Shared recipe for media pre-inference cost in cents:
 *   Σ(price × multiplier) + per-model storage
 *
 * `prices` are fee-inclusive per-unit prices (as carried by `Model.pricePer*` /
 * `ModelInfo.pricing.*` after `processModels` / `rawModelToModelInfo` bake fees
 * in). Fees are NOT re-applied here.
 *
 * Image: multiplier = 1, storageBytes = ESTIMATED_IMAGE_BYTES.
 * Video/Audio: multiplier = duration, storageBytes = duration × bytesPerSecond.
 *
 * Returns 0 when there are no prices OR when multiplier is 0 — both image
 * (multiplier always 1) and video/audio (multiplier=0 → fully zero cost) match
 * the historical behavior. Per-model storage tracks the count of priced models.
 */
function computeMediaWorstCaseCents(input: {
  prices: readonly number[];
  multiplier: number;
  storageBytesPerModel: number;
}): number {
  const { prices, multiplier, storageBytesPerModel } = input;
  if (prices.length === 0 || multiplier === 0) return 0;
  const sumModelCost = prices.reduce((s, p) => s + p * multiplier, 0);
  const storage = mediaStorageCost(storageBytesPerModel) * prices.length;
  return (sumModelCost + storage) * 100;
}

/**
 * Pre-inference worst-case cost for image generation in cents.
 * Uses ESTIMATED_IMAGE_BYTES as the storage estimate; actual cost is
 * recomputed post-inference with the real R2 object size.
 */
export function computeImageWorstCaseCents(perImage: number, modelCount: number): number {
  if (modelCount === 0) return 0;
  return computeMediaWorstCaseCents({
    prices: Array.from({ length: modelCount }, () => perImage),
    multiplier: 1,
    storageBytesPerModel: ESTIMATED_IMAGE_BYTES,
  });
}

export interface EstimateVideoWorstCaseCentsInput {
  perSecond: number;
  durationSeconds: number;
  modelCount: number;
}

/**
 * Pre-inference worst-case cost for video generation in cents.
 * Uses `durationSeconds × ESTIMATED_VIDEO_BYTES_PER_SECOND` as the storage
 * estimate; actual cost is recomputed post-inference with the real R2 size.
 */
export function estimateVideoWorstCaseCents(input: EstimateVideoWorstCaseCentsInput): number {
  const { perSecond, durationSeconds, modelCount } = input;
  if (modelCount === 0) return 0;
  return computeMediaWorstCaseCents({
    prices: Array.from({ length: modelCount }, () => perSecond),
    multiplier: durationSeconds,
    storageBytesPerModel: durationSeconds * ESTIMATED_VIDEO_BYTES_PER_SECOND,
  });
}

/**
 * Exact pre-inference cost for image generation in cents, given the actual
 * fee-inclusive per-image price of each selected model. Image pricing is
 * deterministic at reservation time, so there's no need for a worst-case
 * estimate — we sum the real prices and add per-model storage.
 */
export function computeImageExactCents(pricesPerImage: readonly number[]): number {
  return computeMediaWorstCaseCents({
    prices: pricesPerImage,
    multiplier: 1,
    storageBytesPerModel: ESTIMATED_IMAGE_BYTES,
  });
}

/**
 * Exact pre-inference cost for video generation in cents, given each selected
 * model's `perSecond` price at the requested resolution and the user's chosen
 * duration. Like image, video pricing is deterministic at reservation time,
 * so this replaces the worst-case formula for multi-model billing.
 */
export function computeVideoExactCents(
  pricesPerSecond: readonly number[],
  durationSeconds: number
): number {
  return computeMediaWorstCaseCents({
    prices: pricesPerSecond,
    multiplier: durationSeconds,
    storageBytesPerModel: durationSeconds * ESTIMATED_VIDEO_BYTES_PER_SECOND,
  });
}

/**
 * Worst-case pre-inference cost for audio (TTS) generation in cents. Unlike
 * image and video — where the count or duration is fixed in the request — TTS
 * output length emerges from the synthesis, so we reserve against the user's
 * `maxDurationSeconds` cap and rebill at the actual generated `durationMs`.
 *
 * Same shape as `computeVideoExactCents`: sum per-model (fee-inclusive
 * perSecond × maxDuration), add per-model storage. The "WorstCase" suffix
 * mirrors text's `computeWorstCaseCents` (both reserve against an upper
 * bound that the actual output usually undershoots).
 */
export function computeAudioWorstCaseCents(
  pricesPerSecond: readonly number[],
  maxDurationSeconds: number
): number {
  return computeMediaWorstCaseCents({
    prices: pricesPerSecond,
    multiplier: maxDurationSeconds,
    storageBytesPerModel: maxDurationSeconds * ESTIMATED_AUDIO_BYTES_PER_SECOND,
  });
}

/**
 * Worst-case Perplexity Search cost (in USD, fees included) for a single
 * text-streaming request when web search is enabled. The pre-flight reservation
 * uses this so a user with `webSearchEnabled === true` is fronted enough budget
 * to cover up to `MAX_SEARCH_TOOL_CALLS` tool invocations. Post-flight billing
 * pulls the gateway's `totalCost`, which already includes search.
 */
export function worstCaseSearchCost(): number {
  return applyFees(MAX_SEARCH_TOOL_CALLS * SEARCH_COST_PER_CALL);
}
