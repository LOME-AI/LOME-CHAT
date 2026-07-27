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

/** Payment expiration time in milliseconds (30 minutes) */
export const PAYMENT_EXPIRATION_MS = 30 * 60 * 1000;

/**
 * Time-to-live for presigned R2 GET URLs, in seconds.
 * Short enough to prevent long-lived leaks, long enough for clients
 * to fetch and decrypt media after unwrapping the content key.
 */
export const MEDIA_DOWNLOAD_URL_TTL_SECONDS = 300;

/** Maximum bytes for a single-PUT R2 upload via the Worker. Multipart is not supported. */
export const MAX_MEDIA_OBJECT_BYTES = 250_000_000; // 250 MB

/**
 * Byte budget for the workflow engine's in-memory ValueStore — the ceiling every
 * mid-flow value of one run shares, assuming a ≥3× real-memory multiplier over the
 * metered size. It lives here because two slices must agree on it: the engine
 * meters against it, and admission's media size gate refuses a declaration that
 * could not possibly fit it. Neither may reach into the other (the models domain
 * cannot import `workflows/engine`, and a workflows-barrel import would make the
 * dependency bidirectional), so the shared package is the one home.
 */
export const VALUE_STORE_BYTE_BUDGET_BYTES = 20 * 1024 * 1024;

/** Minimum video duration users can request, in seconds. */
export const MIN_VIDEO_DURATION_SECONDS = 1;

/** Maximum video duration users can request, in seconds. */
export const MAX_VIDEO_DURATION_SECONDS = 8;

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

/** Audio output formats offered in the audio config picker. Single source of truth — request schema derives from this. */
export const AUDIO_FORMATS = ['mp3', 'wav', 'ogg'] as const;

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
