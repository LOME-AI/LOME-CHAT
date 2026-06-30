/**
 * Maps machine-readable error codes to user-facing messages.
 *
 * This is the single source of truth for all user-facing error messages.
 * Backend returns `{ code: string }`, frontend calls `legacyFriendlyErrorMessage(code)`
 * to get the human-readable string displayed to users.
 */

declare const __brand: unique symbol;

/**
 * A string that has been validated as a user-facing message.
 *
 * Produced by `legacyFriendlyErrorMessage()` (from an error code) or
 * `customUserMessage()` (from a hand-written string).
 *
 * `createChatError()` requires this type, preventing raw strings
 * from being passed without explicit mapping.
 */
export type UserFacingMessage = string & { readonly [__brand]: 'UserFacingMessage' };

const ERROR_MESSAGES = {
  UNAUTHORIZED: 'You are not logged in. Please log in and try again.',
  NOT_FOUND: "The item you're looking for doesn't exist.",
  VALIDATION: 'Invalid input. Please check your data and try again.',
  INSUFFICIENT_BALANCE: 'Insufficient balance.',
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
  INTERNAL: 'Something went wrong. Please try again later.',
  FORBIDDEN: "You don't have permission to do this.",
  PAYMENT_REQUIRED: 'Payment is required for this action.',
  CONFLICT: 'This action conflicts with the current state. Please refresh and try again.',
  INVALID_OPERATION: 'This operation is not supported in the current context.',
  EXPIRED: 'This item has expired.',
  SERVICE_UNAVAILABLE: 'This service is temporarily unavailable. Please try again later.',
  BILLING_MISMATCH: 'Billing state has changed. Please retry.',
  CSRF_REJECTED: 'Request rejected for security reasons. Please refresh and try again.',

  AUTH_FAILED: 'Invalid credentials.',
  LOGIN_FAILED: 'Login failed. Please check your credentials and try again.',
  LOGIN_INIT_FAILED: 'Login failed. Please try again.',
  REGISTRATION_FAILED: 'Registration failed. Please try again.',
  USER_CREATION_FAILED: 'Account creation failed. Please try again.',
  ENCRYPTION_NOT_SETUP: 'Your account encryption is not configured. Please contact support.',
  EMAIL_NOT_VERIFIED:
    'Please verify your email address. Check your inbox for the verification link.',
  NOT_AUTHENTICATED: 'Your session has expired. Please log in again.',
  SESSION_REVOKED: 'Your session has been revoked. Please log in again.',
  PASSWORD_CHANGED: 'Your password was changed. Please log in again.',
  NO_PENDING_LOGIN: 'Your login session expired. Please try again.',
  NO_PENDING_REGISTRATION: 'Your registration session expired. Please start over.',
  NO_PENDING_CHANGE: 'Your password change session expired. Please start over.',
  NO_PENDING_RECOVERY: 'Your recovery session expired. Please start over.',
  INCORRECT_PASSWORD: 'Incorrect password.',
  CHANGE_PASSWORD_FAILED: 'Password change failed. Please try again.',
  CHANGE_PASSWORD_INIT_FAILED: 'Password change failed. Please try again.',
  CHANGE_PASSWORD_REG_FAILED: 'Password change failed. Please try again.',
  ACCOUNT_KEY_NOT_AVAILABLE: 'Your encryption key is unavailable. Please log out and log back in.',
  VERIFICATION_FAILED: 'Email verification failed. Please try again or request a new link.',
  INVALID_OR_EXPIRED_TOKEN: 'This link has expired. Please request a new verification email.',

  '2FA_VERIFICATION_FAILED': 'Two-factor verification failed. Please try again.',
  '2FA_REQUIRED': 'Two-factor authentication is required.',
  '2FA_EXPIRED': 'Your two-factor session expired. Please log in again.',
  INVALID_TOTP_CODE: 'Invalid verification code. Please try again.',
  TOTP_NOT_CONFIGURED: 'Two-factor authentication is not configured. Please contact support.',
  TOTP_NOT_ENABLED: 'Two-factor authentication is not enabled on this account.',
  TOTP_ALREADY_ENABLED: 'Two-factor authentication is already enabled.',
  NO_PENDING_2FA: 'Your two-factor session expired. Please log in again.',
  NO_PENDING_2FA_SETUP: 'Your two-factor setup session expired. Please start over.',
  NO_PENDING_DISABLE: 'Your two-factor disable session expired. Please start over.',
  DISABLE_2FA_INIT_FAILED: 'Failed to start two-factor disable. Please try again.',

  USER_NOT_FOUND: 'Account not found.',
  SERVER_MISCONFIGURED: 'Something went wrong on our end. Please try again later.',
  INVALID_BASE64: 'Something went wrong with your request. Please try again.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Your account has been temporarily locked.',

  CONVERSATION_NOT_FOUND: 'Conversation not found.',
  MODEL_NOT_FOUND: 'Model not found.',
  LAST_MESSAGE_NOT_USER: 'Last message must be from you.',
  BALANCE_RESERVED: 'Please wait for your current messages to finish before starting more.',
  DAILY_LIMIT_EXCEEDED: 'Daily message limit exceeded.',
  STREAM_ERROR: 'Something went wrong. Please try again or try a different model.',
  BILLING_ERROR: 'Something went wrong saving your message. Your balance was not charged.',
  CHAT_STREAM_FAILED: 'Something went wrong. Please try again or try a different model.',
  STREAM_TIMEOUT: 'The model stopped responding. Please try again.',
  CONTENT_POLICY:
    'The model declined to answer because it considered the request unsafe. Try rephrasing your message.',
  PROVIDER_BILLING:
    "The AI provider rejected our credentials. We're investigating; please try again shortly.",
  NETWORK_ERROR: "We couldn't reach the AI provider. Check your connection and try again.",
  CONTEXT_LENGTH_EXCEEDED:
    'This conversation is too long for the selected model. Try a model with a larger context window.',
  PAYMENT_NOT_FOUND: 'Payment not found.',
  PAYMENT_ALREADY_PROCESSED: 'Payment already processed.',
  PAYMENT_EXPIRED: 'Payment expired.',
  PAYMENT_DECLINED: 'Payment declined.',
  PAYMENT_CREATE_FAILED: 'Failed to create payment.',
  PAYMENT_MISSING_TRANSACTION_ID: 'Payment approved but missing transaction ID.',
  INVALID_SIGNATURE: 'Something went wrong with your request. Please try again.',
  INVALID_JSON: 'Something went wrong with your request. Please try again.',
  WEBHOOK_VERIFIER_MISSING: 'Webhook processing unavailable.',
  PREMIUM_REQUIRES_BALANCE: 'Premium models require a positive balance.',
  PREMIUM_REQUIRES_ACCOUNT: 'Premium models require a free account.',
  MODEL_TIER_LOCKED:
    'This model is only available for paid accounts. Top up your balance to unlock.',
  TRIAL_MESSAGE_TOO_EXPENSIVE: 'This message exceeds trial limits. Sign up for more capacity.',
  AUTHENTICATED_ON_TRIAL: 'Authenticated users should use the main chat.',
  FEATURE_REQUIRES_AUTH: 'This feature requires a free account. Please sign up to use it.',
  MEMBER_LIMIT_REACHED: 'Conversation has reached the maximum of 100 members.',
  PRIVILEGE_INSUFFICIENT: 'Insufficient privilege for this action.',
  MEMBER_NOT_FOUND: 'Member not found.',
  CANNOT_REMOVE_OWNER: 'Cannot remove the conversation owner.',
  ALREADY_MEMBER: 'User is already an active member.',
  CANNOT_REMOVE_SELF: 'Use the leave button to leave a conversation.',
  CANNOT_CHANGE_OWN_PRIVILEGE: 'Cannot change your own privilege.',
  LINK_NOT_FOUND: 'Link not found or already revoked.',
  EPOCH_NOT_FOUND: 'This conversation is out of sync. Please refresh the page.',
  MESSAGE_NOT_FOUND: 'Message not found.',
  SHARE_NOT_FOUND: 'Shared message not found.',
  SHARE_FORBIDDEN: "You can't share this message.",
  // The next three describe the same underlying class of failure (concurrent
  // edit to membership/epoch) from different surfaces. Match phrasing so users
  // get a consistent retry signal regardless of which code the API returned.
  STALE_EPOCH: 'Someone else just changed this conversation. Please try again.',
  WRAP_SET_MISMATCH: 'Members changed while you were working. Please try again.',
  ROTATION_REQUIRED:
    "This action couldn't complete because the conversation changed. Please try again.",

  REGENERATION_BLOCKED_BY_OTHER_USER:
    'Cannot regenerate — another user has replied after this message.',
  FORK_NOT_FOUND: 'Fork not found.',
  FORK_NAME_TAKEN: 'A fork with this name already exists.',
  USERNAME_TAKEN: 'That username is already taken. Please choose another.',
  EMAIL_TAKEN: 'An account with that email already exists. Try logging in instead.',
  FORK_LIMIT_REACHED: 'Maximum number of forks reached for this conversation.',
  FORK_ID_REQUIRED: 'Something went wrong. Please refresh the page and try again.',
  TARGET_MESSAGE_NOT_FOUND: 'Target message not found.',
  INVALID_PARENT_MESSAGE: 'Something went wrong saving your message. Please try again.',
  CANNOT_REGENERATE_WHILE_STREAMING: 'Please wait for the current response to finish.',
  FORK_TIP_CONFLICT: 'Another reply landed at the same time. Please retry.',
  DUPLICATE_MESSAGE: 'This message was already sent. Refresh to see the latest state.',

  UPGRADE_REQUIRED: 'A new version is available. Please update to continue.',
  LOGIN_TOKEN_INVALID: 'This login link has expired or already been used.',
  BILLING_SESSION_RESTRICTED:
    'This session can only access billing. Please log in normally for full access.',
  BUILD_NOT_FOUND: 'The requested app version was not found.',

  STORAGE_WRITE_FAILED: "We couldn't save the generated media. Please try again.",
  MEDIA_TOO_LARGE: 'Generated media is too large to store. Please try a smaller request.',
  STORAGE_READ_FAILED: "We couldn't load this media. Please refresh the page.",
  CONTENT_ITEM_NOT_FOUND: 'Content item not found.',
  CONTENT_ITEM_NOT_MEDIA: 'This content item is not downloadable media.',
  INFERENCE_FAILED: "The AI provider couldn't complete your request. Please try again in a moment.",
  EMPTY_MEDIA_RESULT:
    "The AI didn't produce any output for your request. Try rephrasing your prompt.",
  UNKNOWN_MIME_TYPE: "The generated media couldn't be identified. Please report this.",
  MEDIA_TRIAL_BLOCKED:
    'Media generation is only available for signed-in users. Create an account to unlock.',
  MODALITY_MISMATCH: "One or more selected models don't match the requested content type.",
  MISSING_MODALITY_CONFIG:
    'The selected content type needs configuration (aspect ratio, duration, or resolution).',
  UNSUPPORTED_RESOLUTION:
    "One or more selected video models don't support the requested resolution. Pick a different resolution.",
  UNSUPPORTED_DURATION:
    "One or more selected video models don't support the requested duration. Pick a different duration.",
  AUDIO_DISABLED: 'Audio generation is not yet available. Please try a different content type.',
  CLASSIFIER_FAILED:
    'Smart Model could not pick the best model for your message. Please try again.',

  DELETE_ACCOUNT_LOCKED: 'Too many deletion attempts. Try again later.',
  INVALID_CONFIRMATION_PHRASE: "Confirmation text didn't match.",
  NO_PENDING_DELETE_ACCOUNT: 'Your deletion session expired. Start again.',
  TOTP_CODE_REQUIRED: 'Enter your 6-digit verification code to continue.',
} as const satisfies Record<string, string>;

/** Known error code — union of all keys in the error message map. */
export type LegacyErrorCode = keyof typeof ERROR_MESSAGES;

const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Maps a machine-readable error code to a branded user-facing message.
 *
 * Accepts `LegacyErrorCode` (for autocomplete) or any string (for network-parsed codes).
 * Unknown codes return the generic fallback.
 */

export function legacyFriendlyErrorMessage(
  code: LegacyErrorCode | (string & {})
): UserFacingMessage {
  const message = (ERROR_MESSAGES as Record<string, string>)[code] ?? FALLBACK_MESSAGE;
  return message as UserFacingMessage;
}

/**
 * Wraps a hand-written string as a `UserFacingMessage`.
 *
 * Use when the message is not from the error code map — e.g., custom
 * markdown messages with signup links in the trial chat.
 */
export function customUserMessage(message: string): UserFacingMessage {
  return message as UserFacingMessage;
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * 60;

// Always rounds up so the displayed wait is never shorter than the real one.
export function formatLockoutMessage(retryAfterSeconds: number): UserFacingMessage {
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return 'Too many attempts. Try again in a moment.' as UserFacingMessage;
  }
  if (retryAfterSeconds < SECONDS_PER_MINUTE) {
    const seconds = Math.ceil(retryAfterSeconds);
    return `Too many attempts. Try again in ${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}.` as UserFacingMessage;
  }
  if (retryAfterSeconds < SECONDS_PER_HOUR) {
    const minutes = Math.ceil(retryAfterSeconds / SECONDS_PER_MINUTE);
    return `Too many attempts. Try again in ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}.` as UserFacingMessage;
  }
  const hours = Math.ceil(retryAfterSeconds / SECONDS_PER_HOUR);
  return `Too many attempts. Try again in ${String(hours)} ${hours === 1 ? 'hour' : 'hours'}.` as UserFacingMessage;
}
