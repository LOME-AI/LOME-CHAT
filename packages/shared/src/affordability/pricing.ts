import { CHARS_PER_TOKEN_STANDARD, TOTAL_FEE_RATE } from './constants.js';

/**
 * Tokens a character count is likely to be, at the standard ~4-chars-per-token
 * approximation. DISPLAY ONLY — the marketing site's illustrative monthly-cost
 * figure is its only caller.
 *
 * This is deliberately NOT the money path's char→token conversion, and the two
 * answer different questions. `estimateTokensForTier` sizes a RESERVATION: it is
 * tier-skewed (paid 4 chars per token, every other tier 2) so the tier whose
 * overruns the platform absorbs over-reserves, and it decides what a payer is
 * allowed to send. This one sizes an ILLUSTRATION with no payer and no tier, in
 * the same spirit as `computePromptCapacity`'s deliberately tier-independent
 * ratio, and nothing it returns reaches a hold, a charge or a verdict.
 *
 * The ratio is read from {@link CHARS_PER_TOKEN_STANDARD} rather than written as
 * a literal, so "the standard approximation" has exactly one value in the repo
 * even though the two questions above stay separate.
 *
 * It takes a COUNT, not the characters: the money layer accepts no content, and
 * its one caller was fabricating a padded string purely to have a length read
 * back off it.
 */
export function estimateTokenCount(characterCount: number): number {
  if (!Number.isSafeInteger(characterCount) || characterCount < 0) {
    throw new RangeError('estimateTokenCount: characterCount must be a non-negative integer');
  }
  return Math.ceil(characterCount / CHARS_PER_TOKEN_STANDARD);
}

/**
 * Apply the total fee to a RAW base price (a price NOT already fee-inclusive).
 * SINGLE SOURCE OF TRUTH for float fee application. Model catalog rates are
 * already fee-inclusive (baked at catalog ingestion), so this is only for raw
 * constants/inputs (e.g. the marketing fee-breakdown display).
 *
 * The total fee rate is the sum of every non-zero category in FEE_CATEGORIES
 * (see `./fees.ts`). Setting any individual rate to 0 cascades through every
 * pricing surface automatically.
 */
export function applyFees(basePrice: number): number {
  return basePrice * (1 + TOTAL_FEE_RATE);
}
