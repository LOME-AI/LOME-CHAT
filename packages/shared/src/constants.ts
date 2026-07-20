/** CSS media query for detecting coarse pointer (touch) devices */
export const TOUCH_QUERY = '(pointer: coarse)';

/** Shared password for all dev personas. Only for local development. */
export const DEV_PASSWORD = 'pass1234';

/** Email domain for development personas */
export const DEV_EMAIL_DOMAIN = 'dev.hushbox.ai';

/** Email domain for test personas (used by E2E tests) */
export const TEST_EMAIL_DOMAIN = 'test.hushbox.ai';

/**
 * Synthetic ID for HushBox's Smart Model — the classifier-based router
 * that picks the best underlying model per message. Stable identifier the
 * frontend persists in user prefs and the backend special-cases on its
 * classifier path.
 */
export const SMART_MODEL_ID = 'smart-model';

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

/** Payment expiration time in milliseconds (30 minutes) */
export const PAYMENT_EXPIRATION_MS = 30 * 60 * 1000;

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
 * Time-to-live for presigned R2 GET URLs, in seconds.
 * Short enough to prevent long-lived leaks, long enough for clients
 * to fetch and decrypt media after unwrapping the content key.
 */
export const MEDIA_DOWNLOAD_URL_TTL_SECONDS = 300;

/** Maximum bytes for a single-PUT R2 upload via the Worker. Multipart is not supported. */
export const MAX_MEDIA_OBJECT_BYTES = 250_000_000; // 250 MB

/** Minimum video duration users can request, in seconds. */
export const MIN_VIDEO_DURATION_SECONDS = 1;

/** Maximum video duration users can request, in seconds. */
export const MAX_VIDEO_DURATION_SECONDS = 8;

/**
 * Conservative byte estimate per second of generated video (encrypted).
 * Used only for pre-flight reservation. Worst-case 1080p; actual cost
 * uses real `sizeBytes` from the R2 upload.
 */
export const ESTIMATED_VIDEO_BYTES_PER_SECOND = 5_000_000;

/** Aspect ratios offered in the video config picker. Single source of truth — request schema derives from this. */
export const VIDEO_ASPECT_RATIOS = ['16:9', '9:16'] as const;

/** Resolutions offered in the video config picker. Single source of truth — request schema derives from this. */
export const VIDEO_RESOLUTIONS = ['720p', '1080p', '4k'] as const;

/** Aspect ratios offered in the image config picker. Single source of truth — request schema derives from this. */
export const IMAGE_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;

/**
 * Maximum audio duration the user can cap a TTS generation at, in seconds.
 * Unlike video (deterministic duration in the request), TTS duration emerges
 * from synthesizing the input text, so the user picks an upper bound that
 * caps worst-case spend; the actual bill uses the generated `durationMs`.
 */
export const MAX_AUDIO_DURATION_SECONDS = 600;

/**
 * Conservative byte estimate per second of generated audio (encrypted).
 * 256 kbps ≈ 32 KB/s — well above typical TTS output. Used only for
 * pre-flight reservation; actual cost uses real `sizeBytes` from R2.
 */
export const ESTIMATED_AUDIO_BYTES_PER_SECOND = 32_000;

/** Audio output formats offered in the audio config picker. Single source of truth — request schema derives from this. */
export const AUDIO_FORMATS = ['mp3', 'wav', 'ogg'] as const;

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

/** Feature flags for conditional feature rendering */
interface FeatureFlags {
  /** Enable settings feature in user menu. Currently disabled pending feature completion */
  SETTINGS_ENABLED: boolean;
  /** Enable audio generation UI. Flip to true when the AI Gateway ships audio output support. */
  AUDIO_ENABLED: boolean;
}

export const FEATURE_FLAGS: FeatureFlags = {
  SETTINGS_ENABLED: true,
  AUDIO_ENABLED: false,
};

/** Maximum number of members (users + link guests) allowed in a single conversation */
export const MAX_CONVERSATION_MEMBERS = 100;

/** Maximum number of forks allowed per conversation */
export const MAX_FORKS_PER_CONVERSATION = 5;

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

/** Maximum number of models that can be selected simultaneously for multi-model chat */
export const MAX_SELECTED_MODELS = 5;

/**
 * Maximum gap between SSE events before the client gives up on a chat stream.
 * Surfaces a server crash mid-stream so the UI can clear "streaming" state.
 * No reconnection is attempted — the failure is reported and the user retries.
 */
export const STREAM_TIMEOUT_MS = 90_000;

/**
 * Cadence at which the media pipeline writes SSE keep-alive comment lines
 * (`:keep-alive\n\n`). Per the SSE spec, lines starting with `:` are comments
 * and are discarded by EventSource consumers; we use them so a slow video
 * generation (>90s with no events between `model:media:start` and `done`)
 * still resets {@link STREAM_TIMEOUT_MS} on the client and avoids a spurious
 * timeout. Keep strictly below `STREAM_TIMEOUT_MS / 2` so two consecutive
 * heartbeats never miss the timeout window.
 */
export const KEEPALIVE_INTERVAL_MS = 30_000;

/** Effective date for the Privacy Policy (YYYY-MM-DD) */
export const PRIVACY_POLICY_EFFECTIVE_DATE = '2026-05-15';

/** Effective date for the Terms of Service (YYYY-MM-DD) */
export const TERMS_OF_SERVICE_EFFECTIVE_DATE = '2026-05-15';

/** Contact email for billing-related inquiries */
export const BILLING_CONTACT_EMAIL = 'billing@hushbox.ai';

/** Contact email for privacy-related inquiries */
export const PRIVACY_CONTACT_EMAIL = 'privacy@hushbox.ai';

/** Phrase typed by the user to confirm account deletion (compared trim+lowercased, no NFKC). */
export const DELETE_ACCOUNT_CONFIRMATION_PHRASE = 'delete my account';

/** Minimum new-password length enforced at every password-entry surface. */
export const MIN_PASSWORD_LENGTH = 8;

/** Minimum card-loading deposit, in whole US dollars (README pricing). */
export const MIN_DEPOSIT_USD = 5;
