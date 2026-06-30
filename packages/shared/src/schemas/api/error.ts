import { z } from 'zod';

/** Unauthorized - authentication required or invalid */
export const ERROR_CODE_UNAUTHORIZED = 'UNAUTHORIZED';

/** Resource not found */
export const ERROR_CODE_NOT_FOUND = 'NOT_FOUND';

/** Validation error - invalid input */
export const ERROR_CODE_VALIDATION = 'VALIDATION';

/** Insufficient balance to perform operation */
export const ERROR_CODE_INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE';

/** Rate limit exceeded */
export const ERROR_CODE_RATE_LIMITED = 'RATE_LIMITED';

/** Internal server error */
export const ERROR_CODE_INTERNAL = 'INTERNAL';

/** Forbidden - authenticated but not authorized */
export const ERROR_CODE_FORBIDDEN = 'FORBIDDEN';

/** Payment required - operation needs funds */
export const ERROR_CODE_PAYMENT_REQUIRED = 'PAYMENT_REQUIRED';

/** Conflict - resource already in conflicting state */
export const ERROR_CODE_CONFLICT = 'CONFLICT';

/** Invalid operation - request shape valid but operation not supported in current context */
export const ERROR_CODE_INVALID_OPERATION = 'INVALID_OPERATION';

/** Expired - resource or token has expired */
export const ERROR_CODE_EXPIRED = 'EXPIRED';

/** Service unavailable - required infrastructure not available */
export const ERROR_CODE_SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE';

/** Billing mismatch - frontend and backend disagree on funding source */
export const ERROR_CODE_BILLING_MISMATCH = 'BILLING_MISMATCH';

/** CSRF rejected - cross-site request forgery protection triggered */
export const ERROR_CODE_CSRF_REJECTED = 'CSRF_REJECTED';

/** Authentication failed - invalid credentials */
export const ERROR_CODE_AUTH_FAILED = 'AUTH_FAILED';

/** Login failed - generic client-side login error */
export const ERROR_CODE_LOGIN_FAILED = 'LOGIN_FAILED';

/** Login init failed - OPAQUE init step failed */
export const ERROR_CODE_LOGIN_INIT_FAILED = 'LOGIN_INIT_FAILED';

/** Registration failed - generic client-side registration error */
export const ERROR_CODE_REGISTRATION_FAILED = 'REGISTRATION_FAILED';

/** User creation failed - server-side user insert error */
export const ERROR_CODE_USER_CREATION_FAILED = 'USER_CREATION_FAILED';

/** Encryption not setup - missing password-wrapped private key */
export const ERROR_CODE_ENCRYPTION_NOT_SETUP = 'ENCRYPTION_NOT_SETUP';

/** Email not verified - user must verify before proceeding */
export const ERROR_CODE_EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

/** Not authenticated - session expired or missing */
export const ERROR_CODE_NOT_AUTHENTICATED = 'NOT_AUTHENTICATED';

/** Session revoked - session invalidated (e.g. logged out from another device) */
export const ERROR_CODE_SESSION_REVOKED = 'SESSION_REVOKED';

/** Password changed - session predates a password change */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
export const ERROR_CODE_PASSWORD_CHANGED = 'PASSWORD_CHANGED';

/** No pending login - OPAQUE login state expired in Redis */
export const ERROR_CODE_NO_PENDING_LOGIN = 'NO_PENDING_LOGIN';

/** No pending registration - OPAQUE registration state expired in Redis */
export const ERROR_CODE_NO_PENDING_REGISTRATION = 'NO_PENDING_REGISTRATION';

/** No pending password change - change-password state expired in Redis */
export const ERROR_CODE_NO_PENDING_CHANGE = 'NO_PENDING_CHANGE';

/** No pending recovery - recovery state expired in Redis */
export const ERROR_CODE_NO_PENDING_RECOVERY = 'NO_PENDING_RECOVERY';

/** Incorrect password - current password verification failed */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
export const ERROR_CODE_INCORRECT_PASSWORD = 'INCORRECT_PASSWORD';

/** Change password failed - generic client-side error */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
export const ERROR_CODE_CHANGE_PASSWORD_FAILED = 'CHANGE_PASSWORD_FAILED';

/** Change password init failed - OPAQUE init step failed */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
export const ERROR_CODE_CHANGE_PASSWORD_INIT_FAILED = 'CHANGE_PASSWORD_INIT_FAILED';

/** Change password registration failed - OPAQUE reg step failed */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- error code constant, not a credential
export const ERROR_CODE_CHANGE_PASSWORD_REG_FAILED = 'CHANGE_PASSWORD_REG_FAILED';

/** Account key not available - private key not in memory */
export const ERROR_CODE_ACCOUNT_KEY_NOT_AVAILABLE = 'ACCOUNT_KEY_NOT_AVAILABLE';

/** Email verification failed - generic client-side error */
export const ERROR_CODE_VERIFICATION_FAILED = 'VERIFICATION_FAILED';

/** Invalid or expired verification token */
export const ERROR_CODE_INVALID_OR_EXPIRED_TOKEN = 'INVALID_OR_EXPIRED_TOKEN';

/** 2FA verification failed - generic client-side error */
export const ERROR_CODE_2FA_VERIFICATION_FAILED = '2FA_VERIFICATION_FAILED';

/** 2FA required - login needs TOTP verification */
export const ERROR_CODE_2FA_REQUIRED = '2FA_REQUIRED';

/** 2FA expired - pending 2FA state expired in Redis */
export const ERROR_CODE_2FA_EXPIRED = '2FA_EXPIRED';

/** Invalid TOTP code */
export const ERROR_CODE_INVALID_TOTP_CODE = 'INVALID_TOTP_CODE';

/** TOTP not configured - secret missing from DB */
export const ERROR_CODE_TOTP_NOT_CONFIGURED = 'TOTP_NOT_CONFIGURED';

/** TOTP not enabled - user hasn't enabled 2FA */
export const ERROR_CODE_TOTP_NOT_ENABLED = 'TOTP_NOT_ENABLED';

/** TOTP already enabled - can't enable twice */
export const ERROR_CODE_TOTP_ALREADY_ENABLED = 'TOTP_ALREADY_ENABLED';

/** No pending 2FA - login 2FA state expired */
export const ERROR_CODE_NO_PENDING_2FA = 'NO_PENDING_2FA';

/** No pending 2FA setup - TOTP setup state expired */
export const ERROR_CODE_NO_PENDING_2FA_SETUP = 'NO_PENDING_2FA_SETUP';

/** No pending disable - 2FA disable state expired */
export const ERROR_CODE_NO_PENDING_DISABLE = 'NO_PENDING_DISABLE';

/** Disable 2FA init failed */
export const ERROR_CODE_DISABLE_2FA_INIT_FAILED = 'DISABLE_2FA_INIT_FAILED';

/** User not found in database */
export const ERROR_CODE_USER_NOT_FOUND = 'USER_NOT_FOUND';

/** Server misconfigured - missing OPAQUE setup or other config */
export const ERROR_CODE_SERVER_MISCONFIGURED = 'SERVER_MISCONFIGURED';

/** Invalid base64 encoding in request */
export const ERROR_CODE_INVALID_BASE64 = 'INVALID_BASE64';

/** Too many attempts - account temporarily locked */
export const ERROR_CODE_TOO_MANY_ATTEMPTS = 'TOO_MANY_ATTEMPTS';

/** Conversation not found */
export const ERROR_CODE_CONVERSATION_NOT_FOUND = 'CONVERSATION_NOT_FOUND';

/** Model not found */
export const ERROR_CODE_MODEL_NOT_FOUND = 'MODEL_NOT_FOUND';

/** Last message in conversation is not from user */
export const ERROR_CODE_LAST_MESSAGE_NOT_USER = 'LAST_MESSAGE_NOT_USER';

/** Balance currently reserved by in-flight messages */
export const ERROR_CODE_BALANCE_RESERVED = 'BALANCE_RESERVED';

/** Daily message limit exceeded */
export const ERROR_CODE_DAILY_LIMIT_EXCEEDED = 'DAILY_LIMIT_EXCEEDED';

/** Payment not found */
export const ERROR_CODE_PAYMENT_NOT_FOUND = 'PAYMENT_NOT_FOUND';

/** Payment already processed */
export const ERROR_CODE_PAYMENT_ALREADY_PROCESSED = 'PAYMENT_ALREADY_PROCESSED';

/** Payment expired */
export const ERROR_CODE_PAYMENT_EXPIRED = 'PAYMENT_EXPIRED';

/** Payment declined by processor */
export const ERROR_CODE_PAYMENT_DECLINED = 'PAYMENT_DECLINED';

/** Failed to create payment */
export const ERROR_CODE_PAYMENT_CREATE_FAILED = 'PAYMENT_CREATE_FAILED';

/** Payment approved but missing transaction ID */
export const ERROR_CODE_PAYMENT_MISSING_TRANSACTION_ID = 'PAYMENT_MISSING_TRANSACTION_ID';

/** Invalid signature on request */
export const ERROR_CODE_INVALID_SIGNATURE = 'INVALID_SIGNATURE';

/** Invalid JSON in request body */
export const ERROR_CODE_INVALID_JSON = 'INVALID_JSON';

/** Webhook verifier not configured */
export const ERROR_CODE_WEBHOOK_VERIFIER_MISSING = 'WEBHOOK_VERIFIER_MISSING';

/** Premium model requires positive balance */
export const ERROR_CODE_PREMIUM_REQUIRES_BALANCE = 'PREMIUM_REQUIRES_BALANCE';

/** Premium model requires a free account */
export const ERROR_CODE_PREMIUM_REQUIRES_ACCOUNT = 'PREMIUM_REQUIRES_ACCOUNT';

/**
 * Selected model is gated to paid accounts and the caller is a free/trial/guest
 * tier user. Distinct from {@link ERROR_CODE_PREMIUM_REQUIRES_BALANCE} (which
 * covers paid users with empty balance) — this one fires when the tier itself
 * disqualifies the user from premium models regardless of balance.
 */
export const ERROR_CODE_MODEL_TIER_LOCKED = 'MODEL_TIER_LOCKED';

/** Trial message exceeds cost limits */
export const ERROR_CODE_TRIAL_MESSAGE_TOO_EXPENSIVE = 'TRIAL_MESSAGE_TOO_EXPENSIVE';

/** Authenticated user on trial endpoint */
export const ERROR_CODE_AUTHENTICATED_ON_TRIAL = 'AUTHENTICATED_ON_TRIAL';

/**
 * Feature requires authentication. Returned by endpoints that defense-in-depth
 * reject requests for paid/auth-only features (e.g., web search) when called
 * by an unauthenticated trial user.
 */
export const ERROR_CODE_FEATURE_REQUIRES_AUTH = 'FEATURE_REQUIRES_AUTH';

/** Conversation member limit reached */
export const ERROR_CODE_MEMBER_LIMIT_REACHED = 'MEMBER_LIMIT_REACHED';

/** Insufficient privilege for action */
export const ERROR_CODE_PRIVILEGE_INSUFFICIENT = 'PRIVILEGE_INSUFFICIENT';

/** Member not found in conversation */
export const ERROR_CODE_MEMBER_NOT_FOUND = 'MEMBER_NOT_FOUND';

/** Cannot remove conversation owner */
export const ERROR_CODE_CANNOT_REMOVE_OWNER = 'CANNOT_REMOVE_OWNER';

/** User is already an active member */
export const ERROR_CODE_ALREADY_MEMBER = 'ALREADY_MEMBER';

/** Cannot remove self - use leave instead */
export const ERROR_CODE_CANNOT_REMOVE_SELF = 'CANNOT_REMOVE_SELF';

/** Cannot change own privilege */
export const ERROR_CODE_CANNOT_CHANGE_OWN_PRIVILEGE = 'CANNOT_CHANGE_OWN_PRIVILEGE';

/** Shared link not found or already revoked */
export const ERROR_CODE_LINK_NOT_FOUND = 'LINK_NOT_FOUND';

/** Current epoch not found */
export const ERROR_CODE_EPOCH_NOT_FOUND = 'EPOCH_NOT_FOUND';

/** Message not found */
export const ERROR_CODE_MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND';

/** Shared message not found */
export const ERROR_CODE_SHARE_NOT_FOUND = 'SHARE_NOT_FOUND';

/**
 * Caller cannot share the requested message because they are not (or are no
 * longer) an active member of the message's conversation. More specific than
 * {@link ERROR_CODE_FORBIDDEN}: the share-create endpoint uses this so the
 * frontend can render a sharing-specific message.
 */
export const ERROR_CODE_SHARE_FORBIDDEN = 'SHARE_FORBIDDEN';

/** Member wrap set does not match active members */
export const ERROR_CODE_WRAP_SET_MISMATCH = 'WRAP_SET_MISMATCH';

/** Epoch rotation required */
export const ERROR_CODE_ROTATION_REQUIRED = 'ROTATION_REQUIRED';

/**
 * Caller rotated against a stale `expectedEpoch` — another client committed a
 * rotation first. 409. The frontend should surface this as "someone else
 * changed this conversation" and let the user retry against the fresh epoch.
 */
export const ERROR_CODE_STALE_EPOCH = 'STALE_EPOCH';

/** Regeneration blocked because another user replied after target message */
export const ERROR_CODE_REGENERATION_BLOCKED_BY_OTHER_USER = 'REGENERATION_BLOCKED_BY_OTHER_USER';

/** Fork not found */
export const ERROR_CODE_FORK_NOT_FOUND = 'FORK_NOT_FOUND';

/** Fork name already taken in this conversation */
export const ERROR_CODE_FORK_NAME_TAKEN = 'FORK_NAME_TAKEN';

/** Registration: requested username collides with an existing account. */
export const ERROR_CODE_USERNAME_TAKEN = 'USERNAME_TAKEN';

/**
 * Registration: requested email is already registered. Today this is
 * masked at /register/init for enumeration resistance; surfaces only if a
 * race makes it past /init.
 */
export const ERROR_CODE_EMAIL_TAKEN = 'EMAIL_TAKEN';

/** Maximum number of forks per conversation reached */
export const ERROR_CODE_FORK_LIMIT_REACHED = 'FORK_LIMIT_REACHED';

/** Fork ID required when conversation has forks */
export const ERROR_CODE_FORK_ID_REQUIRED = 'FORK_ID_REQUIRED';

/** Target message not found for regeneration */
export const ERROR_CODE_TARGET_MESSAGE_NOT_FOUND = 'TARGET_MESSAGE_NOT_FOUND';

/** Parent message ID is invalid — null on non-first message or references nonexistent message */
export const ERROR_CODE_INVALID_PARENT_MESSAGE = 'INVALID_PARENT_MESSAGE';

/** Cannot regenerate while a message is currently streaming */
export const ERROR_CODE_CANNOT_REGENERATE_WHILE_STREAMING = 'CANNOT_REGENERATE_WHILE_STREAMING';

/** Fork tip changed between parent resolution and persistence — concurrent writer won the race. */
export const ERROR_CODE_FORK_TIP_CONFLICT = 'FORK_TIP_CONFLICT';

/** Duplicate user message — same conversation/sequence already persisted (retry hit a PK race). */
export const ERROR_CODE_DUPLICATE_MESSAGE = 'DUPLICATE_MESSAGE';

/** Context length exceeded — conversation too long for the model */
export const ERROR_CODE_CONTEXT_LENGTH_EXCEEDED = 'CONTEXT_LENGTH_EXCEEDED';

/** Generic stream error — AI provider or stream processing failure */
export const ERROR_CODE_STREAM_ERROR = 'STREAM_ERROR';

/** Billing error — failed to save billing after successful stream */
export const ERROR_CODE_BILLING_ERROR = 'BILLING_ERROR';

/** Chat stream failed — generic client-side stream failure */
export const ERROR_CODE_CHAT_STREAM_FAILED = 'CHAT_STREAM_FAILED';

/**
 * Stream went silent — no SSE event received within {@link STREAM_TIMEOUT_MS}.
 * Surfaces a server crash mid-stream (after `start`, before `done`) so the UI
 * can clear the optimistic "streaming" state instead of hanging forever.
 */
export const ERROR_CODE_STREAM_TIMEOUT = 'STREAM_TIMEOUT';

/**
 * Provider returned a content-policy / moderation refusal. Surfaces a
 * targeted UI message asking the user to rephrase, distinct from generic
 * stream errors.
 */
export const ERROR_CODE_CONTENT_POLICY = 'CONTENT_POLICY';

/**
 * Provider auth / billing failure (HTTP 401/402/403, "insufficient credits").
 * Distinct from user-facing PAYMENT_REQUIRED — this is the upstream gateway
 * rejecting our credentials, not the user lacking balance.
 */
export const ERROR_CODE_PROVIDER_BILLING = 'PROVIDER_BILLING';

/**
 * Network / fetch error — connection refused, DNS failure, AbortError mid-stream.
 * Distinguishes transient infrastructure issues from provider-side failures so
 * the UI can suggest "retry" instead of "try a different model".
 */
export const ERROR_CODE_NETWORK_ERROR = 'NETWORK_ERROR';

/** App version outdated - client must update before continuing */
export const ERROR_CODE_UPGRADE_REQUIRED = 'UPGRADE_REQUIRED';

/** Login token invalid or expired - one-time billing login link */
export const ERROR_CODE_LOGIN_TOKEN_INVALID = 'LOGIN_TOKEN_INVALID';

/** Billing-scoped session tried to access non-billing route */
export const ERROR_CODE_BILLING_SESSION_RESTRICTED = 'BILLING_SESSION_RESTRICTED';

/** Requested build version not found in R2 storage */
export const ERROR_CODE_BUILD_NOT_FOUND = 'BUILD_NOT_FOUND';

/** Media storage write failed — R2 PUT returned an error. */
export const ERROR_CODE_STORAGE_WRITE_FAILED = 'STORAGE_WRITE_FAILED';

/** Generated media exceeds the single-PUT size limit; multipart upload not supported. */
export const ERROR_CODE_MEDIA_TOO_LARGE = 'MEDIA_TOO_LARGE';

/** Media storage read failed — presigned URL could not be minted or object fetch failed. */
export const ERROR_CODE_STORAGE_READ_FAILED = 'STORAGE_READ_FAILED';

/** Content item not found, or caller is not a member of its conversation. */
export const ERROR_CODE_CONTENT_ITEM_NOT_FOUND = 'CONTENT_ITEM_NOT_FOUND';

/** Content item exists but is a text item, which has no downloadable URL. */
export const ERROR_CODE_CONTENT_ITEM_NOT_MEDIA = 'CONTENT_ITEM_NOT_MEDIA';

/** AI gateway or provider returned an error during inference. */
export const ERROR_CODE_INFERENCE_FAILED = 'INFERENCE_FAILED';

/** Media generation produced no output bytes (empty result from gateway). */
export const ERROR_CODE_EMPTY_MEDIA_RESULT = 'EMPTY_MEDIA_RESULT';

/**
 * Generated media has a mime type the platform does not recognize. Surfaced
 * during the upload step so corrupt rows never enter the DB. Validated against
 * the mime allowlist enum in `message-shares.ts`.
 */
export const ERROR_CODE_UNKNOWN_MIME_TYPE = 'UNKNOWN_MIME_TYPE';

/** Image/video/audio modality is not available for trial users. */
export const ERROR_CODE_MEDIA_TRIAL_BLOCKED = 'MEDIA_TRIAL_BLOCKED';

/** One or more selected models don't match the requested modality. */
export const ERROR_CODE_MODALITY_MISMATCH = 'MODALITY_MISMATCH';

/**
 * Request modality requires its config block (imageConfig for 'image',
 * videoConfig for 'video') and it was missing or invalid.
 */
export const ERROR_CODE_MISSING_MODALITY_CONFIG = 'MISSING_MODALITY_CONFIG';

/**
 * The requested resolution is not priced by one or more selected video models.
 * Emitted by the video route when `videoConfig.resolution` isn't a key in the
 * model's `pricePerSecondByResolution` map.
 */
export const ERROR_CODE_UNSUPPORTED_RESOLUTION = 'UNSUPPORTED_RESOLUTION';

/**
 * The requested duration is not in one or more selected video models'
 * discrete supported-durations set. Veo's set is non-uniform — {4, 6, 8} for
 * 3.1 and {5, 6, 7, 8} for 3.0 — so a value like 5 passes the outer
 * `MIN/MAX_VIDEO_DURATION_SECONDS` Zod check but fails per-model. The UI's
 * snap-to-nearest slider keeps this from happening in the happy path; the
 * gate catches persisted/tampered values before they reach the provider.
 */
export const ERROR_CODE_UNSUPPORTED_DURATION = 'UNSUPPORTED_DURATION';

/**
 * Audio modality is requested but `FEATURE_FLAGS.AUDIO_ENABLED` is off.
 * Removed when the AI Gateway ships speech-model support and the flag flips.
 */
export const ERROR_CODE_AUDIO_DISABLED = 'AUDIO_DISABLED';

/**
 * Smart Model classifier failed: the call errored out, returned unparseable
 * output, or picked a model not in the eligible set. The Smart slot for this
 * message is aborted; sibling slots (explicit selections) keep streaming.
 */
export const ERROR_CODE_CLASSIFIER_FAILED = 'CLASSIFIER_FAILED';

/**
 * Account-deletion attempt limit (3 failures within 1h) reached. The user is
 * locked out for 24h before any further /delete-account/* requests are honored.
 */
export const ERROR_CODE_DELETE_ACCOUNT_LOCKED = 'DELETE_ACCOUNT_LOCKED';

/**
 * The confirmation phrase typed into the delete-account modal did not match the
 * required `delete my account` string (case-insensitive, trimmed only — no
 * Unicode normalization, to avoid homoglyph false-matches).
 */
export const ERROR_CODE_INVALID_CONFIRMATION_PHRASE = 'INVALID_CONFIRMATION_PHRASE';

/** No pending delete-account OPAQUE state — the /init Redis entry expired. */
export const ERROR_CODE_NO_PENDING_DELETE_ACCOUNT = 'NO_PENDING_DELETE_ACCOUNT';

/** TOTP required but missing — shape error, no lockout counter increment. */
export const ERROR_CODE_TOTP_CODE_REQUIRED = 'TOTP_CODE_REQUIRED';

/**
 * Standard error response schema.
 *
 * All API error responses follow this format:
 * - `code`: Machine-readable error code (required)
 * - `details`: Additional context about the error (optional)
 *
 * Frontend maps `code` → user-facing message via `legacyFriendlyErrorMessage()`.
 */
export const legacyErrorResponseSchema = z.object({
  code: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type LegacyErrorResponse = z.infer<typeof legacyErrorResponseSchema>;
