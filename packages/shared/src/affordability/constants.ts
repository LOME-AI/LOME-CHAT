/** HushBox's profit margin on AI model usage (5%) */
export const HUSHBOX_FEE_RATE = 0.05;

/** Credit card processing fee (4.5%) */
export const CREDIT_CARD_FEE_RATE = 0.045;

/** AI provider overhead fee (5.5%) */
export const PROVIDER_FEE_RATE = 0.055;

/**
 * Total combined fee rate applied to all model usage.
 * SINGLE SOURCE OF TRUTH for fee calculations.
 * Sum of HUSHBOX_FEE_RATE + CREDIT_CARD_FEE_RATE + PROVIDER_FEE_RATE.
 * Setting any individual rate to 0 cascades through every fee-rendering surface
 * (legal, email, marketing, billing UI, README, pricing SVG) via FEE_CATEGORIES
 * in `./fees.ts`.
 */
export const TOTAL_FEE_RATE = HUSHBOX_FEE_RATE + CREDIT_CARD_FEE_RATE + PROVIDER_FEE_RATE;

/**
 * Threshold per 1k tokens (input + output combined, with fees) above which
 * models show an expensive warning. Value is in USD.
 */
export const EXPENSIVE_MODEL_THRESHOLD_PER_1K = 0.1;

/** Characters that fit in one kilobyte */
export const CHARACTERS_PER_KILOBYTE = 1000;

/** Kilobytes in one gigabyte */
export const KILOBYTES_PER_GIGABYTE = 1_000_000;

/** Monthly cost to store one gigabyte in USD */
export const MONTHLY_COST_PER_GB = 0.5;

/** Months in a year */
export const MONTHS_PER_YEAR = 12;

/** Number of years to retain storage */
export const STORAGE_YEARS = 50;

/**
 * Cost per character for storage in USD.
 * Derived: (MONTHLY_COST_PER_GB * MONTHS_PER_YEAR * STORAGE_YEARS) / (CHARACTERS_PER_KILOBYTE * KILOBYTES_PER_GIGABYTE)
 * = ($0.5 * 12 * 50) / (1000 * 1000000) = $300 / 1,000,000,000 = $0.0000003
 */
export const STORAGE_COST_PER_CHARACTER =
  (MONTHLY_COST_PER_GB * MONTHS_PER_YEAR * STORAGE_YEARS) /
  (CHARACTERS_PER_KILOBYTE * KILOBYTES_PER_GIGABYTE);

/**
 * Cost per 1000 characters for storage in USD.
 * Derived: STORAGE_COST_PER_CHARACTER * 1000 = $0.0003
 */
export const STORAGE_COST_PER_1K_CHARS = STORAGE_COST_PER_CHARACTER * 1000;

/** R2 actual ($0.015) + 2x markup for backup/ops/margin */
export const MEDIA_MONTHLY_COST_PER_GB = 0.03;

/**
 * Storage cost per byte for media, derived with 50-year retention.
 * ~$0.000000018/byte → ~$0.018 per 1MB, ~$0.072 per 4MB image
 */
export const MEDIA_STORAGE_COST_PER_BYTE =
  (MEDIA_MONTHLY_COST_PER_GB * MONTHS_PER_YEAR * STORAGE_YEARS) / (1000 * 1_000_000);

/**
 * Conservative byte estimate for a generated image (encrypted).
 * Used for pre-flight budget reservation — overestimates so the user is
 * never charged more than reserved. Actual cost uses real sizeBytes.
 */
export const ESTIMATED_IMAGE_BYTES = 8_000_000;

/**
 * Conservative byte estimate per second of generated video (encrypted).
 * Used only for pre-flight reservation. Worst-case 1080p; actual cost
 * uses real `sizeBytes` from the R2 upload.
 */
export const ESTIMATED_VIDEO_BYTES_PER_SECOND = 5_000_000;

/**
 * Conservative byte estimate per second of generated audio (encrypted).
 * 256 kbps ≈ 32 KB/s — well above typical TTS output. Used only for
 * pre-flight reservation; actual cost uses real `sizeBytes` from R2.
 */
export const ESTIMATED_AUDIO_BYTES_PER_SECOND = 32_000;

/**
 * Maximum allowed negative balance in cents for paid users.
 * Paid users get this cushion above their actual balance.
 * $0.50 = 50 cents
 */
export const MAX_ALLOWED_NEGATIVE_BALANCE_CENTS = 50;

/**
 * Maximum estimated cost per message for trial users in cents.
 * Trial users are limited to cheap messages to prevent abuse.
 * $0.01 = 1 cent
 */
export const MAX_TRIAL_MESSAGE_COST_CENTS = 1;

/**
 * Minimum output tokens to reserve for AI response.
 * Used in budget calculations to ensure meaningful responses.
 */
export const MINIMUM_OUTPUT_TOKENS = 1000;

/**
 * Threshold for low balance warning.
 * When calculated maxOutputTokens < this value, show warning to paid users.
 */
export const LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD = 10_000;

/**
 * Conservative character-per-token ratio for free/trial users.
 * Lower value = more tokens estimated = more conservative cost estimate.
 * We overestimate for free/trial users because we absorb cost overruns.
 */
export const CHARS_PER_TOKEN_CONSERVATIVE = 2;

/**
 * Standard character-per-token ratio for paid users.
 * This is the typical approximation (~4 chars/token for most models).
 */
export const CHARS_PER_TOKEN_STANDARD = 4;

/**
 * Capacity threshold for red zone (warning).
 * When usage >= 67% of model context, show red bar.
 */
export const CAPACITY_RED_THRESHOLD = 0.67;

/**
 * Capacity threshold for yellow zone (caution).
 * When usage >= 33% of model context, show yellow bar.
 * Below this, show green bar.
 */
export const CAPACITY_YELLOW_THRESHOLD = 0.33;

/**
 * Maximum number of Perplexity Search tool calls allowed per text streaming
 * request. Used by the AI SDK's `stopWhen` cap and by `worstCaseSearchCost()`
 * to size the pre-flight reservation.
 */
export const MAX_SEARCH_TOOL_CALLS = 10;

/**
 * Conservative pre-flight cost per Perplexity Search tool call in USD. Real
 * billing comes from the gateway's `totalCost`, which already includes search;
 * this constant only sizes the worst-case reservation up front.
 */
export const SEARCH_COST_PER_CALL = 0.005;

/**
 * Catalog admission's price floor, as nano-USD per 1,000 combined (prompt +
 * completion) tokens: $0.0002/1K, equivalently 200 nano-USD per token.
 *
 * It is a MARGIN floor, so it is tested against the RAW PRE-FEE provider rate —
 * the fee is the margin, so the raw rate decides whether a percentage of it is
 * worth having. At the floor the markup earns $0.00003 per 1,000 tokens while
 * every fixed cost of serving the turn is unchanged, so below it the
 * transaction does not pay for itself.
 *
 * Nano-USD bigint rather than the USD float the specification states, because
 * the comparison it feeds is a money comparison.
 */
export const MIN_PRICE_PER_1K_TOKENS_NANO = 200_000n;

/**
 * Catalog admission's age cutoff: two years. An ageing catalog entry is a
 * maintenance and quality liability, not a commercial one.
 */
export const MAX_MODEL_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * Catalog admission's capability exemption: a model whose context length lands
 * in the top 5% of the pool bypasses the price floor and the age cutoff —
 * exceptional capability buys its way in. It never bypasses the zero-price
 * rule.
 */
export const TOP_CONTEXT_PERCENTILE = 0.95;
