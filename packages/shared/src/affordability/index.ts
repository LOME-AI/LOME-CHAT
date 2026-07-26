/**
 * The money layer's barrel — the only sanctioned way into this directory.
 *
 * Everything under `affordability/` is pure: no database, no cache, no clock,
 * no randomness, no network, and content-free (counts, rates and identifiers
 * only, never a prompt, a message or a history array).
 *
 * The pricing machinery is deliberately absent (`docs/BILLING.md` §Where the
 * Code Lives): the minimum-answer constant, tier ratios, the reasoning-budget
 * ladder, rates, manifests, reducers, per-candidate ceiling solvers and
 * clamping do not appear on this barrel or on the package root. A consumer
 * that needs one of them is evidence the producer is missing a function.
 *
 * `zod` is the only import any production file here makes. The directory's own
 * tests additionally reach for `vitest`, `node:fs`/`node:url`, the seeded-PRNG
 * test helper, the non-money constants half, and the root barrel (the identity
 * pin in `index.test.ts` compares the two barrels' bindings). Anything joining
 * either list is a deliberate, visible edit.
 */

// Named, not `export *`: the minimum-answer constant, the two tier ratios and
// the per-call search rate are behind the wall (`docs/BILLING.md` §Where the
// Code Lives), and a star here would republish them.
export {
  CAPACITY_RED_THRESHOLD,
  CAPACITY_YELLOW_THRESHOLD,
  CHARACTERS_PER_KILOBYTE,
  CREDIT_CARD_FEE_RATE,
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  EXPENSIVE_MODEL_THRESHOLD_PER_1K,
  HUSHBOX_FEE_RATE,
  KILOBYTES_PER_GIGABYTE,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_MODEL_AGE_MS,
  MAX_SEARCH_TOOL_CALLS,
  MAX_TRIAL_MESSAGE_COST_CENTS,
  MIN_PRICE_PER_1K_TOKENS_NANO,
  MEDIA_MONTHLY_COST_PER_GB,
  MEDIA_STORAGE_COST_PER_BYTE,
  MONTHLY_COST_PER_GB,
  MONTHS_PER_YEAR,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_1K_CHARS,
  STORAGE_COST_PER_CHARACTER,
  STORAGE_YEARS,
  TOP_CONTEXT_PERCENTILE,
  TOTAL_FEE_RATE,
} from './constants.js';
export * from './catalog-admission.js';
export * from './fees.js';
export * from './pricing.js';
export * from './tiers.js';
// Named: the output-token clamp is behind the wall; the notice generator is not.
export { generateNotifications } from './budget.js';
export type { BudgetError, MessageSegment, NotificationInput } from './budget.js';
export * from './levenshtein.js';
export * from './modality.js';
// Named, not `export *`: star re-exporting the money module would republish the
// fee-application helpers (`applyMarkup*`) through a second barrel, which the
// fee-seams rule forbids. The root barrel is the one sanctioned publication
// site for those two helpers; everything else here prices over already-billable
// rates.
export { MARKUP_BASIS_POINTS, roundHalfEvenDiv, usdToNanoUsd } from './money.js';
export * from './nano-usd.js';
export * from './param-spec.js';
export * from './model-descriptor.js';
export * from './reasoning-effort.js';
export * from './premium.js';
export * from './priceable-model.js';
// The dimension registry as data — one of the named structural seams. Its
// derivations stay behind the sub-barrel (see `dimensions/index.ts`).
export * from './dimensions/index.js';
export * from './smart-model/index.js';
export * from './billing/funding-decision.js';
export * from './billing/client-billing.js';
export * from './estimate/index.js';
