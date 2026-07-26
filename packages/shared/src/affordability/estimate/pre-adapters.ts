/**
 * Client-facing pre-adapters for the canonical estimator. These are the helpers
 * the CLIENT calls to BUILD a {@link BillableRequest} — tier→token heuristics,
 * output-storage inversion, and the nano-USD balance/cushion math the
 * affordability reducer consumes. They are deliberately OUTSIDE `priceRequest`:
 * the core is input-driven (it receives token counts and rates, never chars or
 * tiers), so these adapters keep the tier-skewed char→token conversion at the
 * edge where the request is assembled. The server feeds real/stamped/ceiling
 * token counts and skips them.
 */

import {
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_TRIAL_MESSAGE_COST_CENTS,
  MINIMUM_OUTPUT_TOKENS,
} from '../constants.js';
import { NANO_USD_PER_CENT } from '../nano-usd.js';
import { STORAGE_COST_PER_CHARACTER_NANO } from './storage-rate.js';
import type { UserTier } from '../tiers.js';

/**
 * Characters-per-token ratio for a tier. Single source of truth for the
 * char↔token conversion: conservative (fewer chars/token → more tokens
 * estimated) for free/trial/guest since the platform absorbs their overruns,
 * standard for paid.
 */
export function charsPerTokenForTier(tier: UserTier): number {
  return tier === 'paid' ? CHARS_PER_TOKEN_STANDARD : CHARS_PER_TOKEN_CONSERVATIVE;
}

/**
 * Estimate input token count from a character count using the tier ratio. A
 * zero-length prompt costs zero tokens; anything else rounds up so the estimate
 * never under-reserves.
 */
export function estimateTokensForTier(tier: UserTier, characterCount: number): number {
  if (characterCount === 0) return 0;
  return Math.ceil(characterCount / charsPerTokenForTier(tier));
}

/**
 * Output-storage chars-per-token, INVERTED from {@link charsPerTokenForTier}:
 * paid → conservative (2), free/trial/guest → standard (4). Output storage is
 * sized with the opposite ratio to input, so the tier that over-reserves input
 * also over-reserves output storage even though the conversion direction
 * (tokens→chars) is reversed.
 */
export function outputCharsPerTokenForTier(tier: UserTier): number {
  return tier === 'paid' ? CHARS_PER_TOKEN_CONSERVATIVE : CHARS_PER_TOKEN_STANDARD;
}

/**
 * Output storage expressed per output token: `outputCharsPerToken ×
 * storageRatePerChar`. THE one home for this multiplication — the estimator's
 * output-storage line item, the classifier line item's storage leg, the
 * per-candidate cap solver and the turn arithmetic's `variableRate` all price
 * through it, so the rate cannot be right in one place and stale in another.
 *
 * Takes a chars-per-token count rather than a tier: the tier-inverted ratio is
 * {@link outputCharsPerTokenForTier}'s business, and per-call sites already hold
 * a resolved count.
 */
export function outputStorageRatePerTokenNanoUsd(outputCharsPerToken: number): bigint {
  return BigInt(outputCharsPerToken) * STORAGE_COST_PER_CHARACTER_NANO;
}

/**
 * The paid negative-balance cushion in nano-USD ($0.50), derived from the same
 * cents constant as the rest of the balance math so the two never drift.
 */
export const PAID_CUSHION_NANO_USD: bigint =
  BigInt(MAX_ALLOWED_NEGATIVE_BALANCE_CENTS) * NANO_USD_PER_CENT;

/** Fixed effective balance a trial/guest turn may spend, in nano-USD. */
const TRIAL_FIXED_BALANCE_NANO_USD: bigint =
  BigInt(MAX_TRIAL_MESSAGE_COST_CENTS) * NANO_USD_PER_CENT;

/**
 * Negative-balance cushion by tier, in nano-USD: only paid wallets may spend
 * into a negative balance, up to this cushion.
 */
export function getCushionNano(tier: UserTier): bigint {
  return tier === 'paid' ? PAID_CUSHION_NANO_USD : 0n;
}

/**
 * Spendable funds for the balance-affordability decision, in nano-USD. Paid
 * wallets may spend into the cushion; every other tier gets no balance cushion
 * (their allowance rides a separate budget scope).
 */
export function spendableFundsNanoUsd(balanceNanoUsd: bigint, tier: UserTier): bigint {
  return balanceNanoUsd + getCushionNano(tier);
}

/**
 * Effective balance the affordability reducer gates against, in nano-USD:
 *  - trial/guest: a fixed per-message ceiling (they run on delegated/quota budget)
 *  - free: the daily free allowance only, no cushion
 *  - paid: the wallet balance plus the negative-balance cushion
 */
export function getEffectiveBalanceNano(
  tier: UserTier,
  balanceNanoUsd: bigint,
  freeAllowanceNanoUsd: bigint
): bigint {
  switch (tier) {
    case 'trial':
    case 'guest': {
      return TRIAL_FIXED_BALANCE_NANO_USD;
    }
    case 'free': {
      return freeAllowanceNanoUsd;
    }
    case 'paid': {
      return spendableFundsNanoUsd(balanceNanoUsd, 'paid');
    }
  }
}

export interface PromptCapacity {
  /** Estimated context usage in tokens: input tokens + the minimum output reserve. */
  currentUsage: number;
  /** The limiting model context length in tokens. */
  maxCapacity: number;
  /** Usage as a percentage of context (0 when the context length is unknown). */
  capacityPercent: number;
}

export interface PromptCapacityInput {
  /** Total prompt characters: system prompt + history + user message. */
  promptCharacterCount: number;
  /** The most restrictive selected model's context length in tokens. */
  modelContextLength: number;
}

/**
 * Context-window capacity for the composer meter. Capacity is NOT a money
 * figure — it always uses the standard 4-chars/token ratio (independent of
 * tier) and is reported separately from affordability so the two concerns stay
 * uncoupled.
 */
export function computePromptCapacity(input: PromptCapacityInput): PromptCapacity {
  const capacityInputTokens = Math.ceil(input.promptCharacterCount / CHARS_PER_TOKEN_STANDARD);
  const currentUsage = capacityInputTokens + MINIMUM_OUTPUT_TOKENS;
  const capacityPercent =
    input.modelContextLength > 0 ? (currentUsage / input.modelContextLength) * 100 : 0;
  return { currentUsage, maxCapacity: input.modelContextLength, capacityPercent };
}
