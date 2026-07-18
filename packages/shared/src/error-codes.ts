import { z } from 'zod';
import type { UserFacingMessage } from './error-messages.js';

/**
 * The closed API error-code set. The wire contract is `{ code, details? }` —
 * never a message field; clients map codes to copy via
 * `friendlyErrorMessage()`.
 *
 * Composition: the eight UPPER-CASE base codes mirror the `DomainError`
 * taxonomy one-to-one (`DOMAIN_ERROR_CODE_TO_WIRE_CODE` below); the rest are
 * the backend's domain-specific typed errors — the concurrent-run hard
 * block, admission refusals (insufficient balance / Redis-down fail-closed),
 * ZDR fail-closed and unsupported-modality, the 426 version check, the CSRF
 * Origin rejection, and the idempotency-key 409 classes. Defects (exceptions
 * reaching a route) surface as INTERNAL with a 500.
 */
export const ERROR_CODES = {
  VALIDATION: 'VALIDATION',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  UNAVAILABLE: 'UNAVAILABLE',
  INTERNAL: 'INTERNAL',
  CONCURRENT_RUN: 'CONCURRENT_RUN',
  INSUFFICIENT_ADMISSION: 'INSUFFICIENT_ADMISSION',
  ADMISSION_UNAVAILABLE: 'ADMISSION_UNAVAILABLE',
  ZDR_REFUSED: 'ZDR_REFUSED',
  UNSUPPORTED_MODALITY: 'UNSUPPORTED_MODALITY',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  BUILD_NOT_FOUND: 'BUILD_NOT_FOUND',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  CSRF_REJECTED: 'CSRF_REJECTED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_BODY_MISMATCH: 'IDEMPOTENCY_BODY_MISMATCH',
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  AUTH_FAILED: 'AUTH_FAILED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  NO_PENDING_LOGIN: 'NO_PENDING_LOGIN',
  NO_PENDING_REGISTRATION: 'NO_PENDING_REGISTRATION',
  INVALID_TOTP_CODE: 'INVALID_TOTP_CODE',
  TOTP_CODE_REQUIRED: 'TOTP_CODE_REQUIRED',
  TOTP_ALREADY_ENABLED: 'TOTP_ALREADY_ENABLED',
  TOTP_NOT_ENABLED: 'TOTP_NOT_ENABLED',
  NO_PENDING_2FA_SETUP: 'NO_PENDING_2FA_SETUP',
  NO_PENDING_STEP_UP: 'NO_PENDING_STEP_UP',
  NO_PENDING_RECOVERY: 'NO_PENDING_RECOVERY',
  INVALID_CONFIRMATION_PHRASE: 'INVALID_CONFIRMATION_PHRASE',
  INVALID_VERIFICATION_TOKEN: 'INVALID_VERIFICATION_TOKEN',
  LOGIN_TOKEN_INVALID: 'LOGIN_TOKEN_INVALID',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  STALE_EPOCH: 'STALE_EPOCH',
  WRAP_SET_MISMATCH: 'WRAP_SET_MISMATCH',
  MEMBER_LIMIT_REACHED: 'MEMBER_LIMIT_REACHED',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  ROTATION_REQUIRED: 'ROTATION_REQUIRED',
  CANNOT_REMOVE_OWNER: 'CANNOT_REMOVE_OWNER',
  CANNOT_REMOVE_SELF: 'CANNOT_REMOVE_SELF',
  CANNOT_CHANGE_OWN_PRIVILEGE: 'CANNOT_CHANGE_OWN_PRIVILEGE',
  PRIVILEGE_INSUFFICIENT: 'PRIVILEGE_INSUFFICIENT',
  FORK_LIMIT_REACHED: 'FORK_LIMIT_REACHED',
  FORK_NAME_TAKEN: 'FORK_NAME_TAKEN',
  FORK_TIP_CONFLICT: 'FORK_TIP_CONFLICT',
  REGENERATION_BLOCKED_BY_OTHER_USER: 'REGENERATION_BLOCKED_BY_OTHER_USER',
  FORK_ID_REQUIRED: 'FORK_ID_REQUIRED',
  AUTHENTICATED_ON_TRIAL: 'AUTHENTICATED_ON_TRIAL',
  TRIAL_LIMIT_REACHED: 'TRIAL_LIMIT_REACHED',
  TRIAL_CAPACITY_REACHED: 'TRIAL_CAPACITY_REACHED',
  FEATURE_REQUIRES_AUTH: 'FEATURE_REQUIRES_AUTH',
  TRIAL_MESSAGE_TOO_EXPENSIVE: 'TRIAL_MESSAGE_TOO_EXPENSIVE',
  PREMIUM_REQUIRES_ACCOUNT: 'PREMIUM_REQUIRES_ACCOUNT',
  MEDIA_TRIAL_BLOCKED: 'MEDIA_TRIAL_BLOCKED',
  MODEL_TIER_LOCKED: 'MODEL_TIER_LOCKED',
  MODEL_DISABLED: 'MODEL_DISABLED',
  DUPLICATE_MESSAGE: 'DUPLICATE_MESSAGE',
  FEEDBACK_SUBMIT_FAILED: 'FEEDBACK_SUBMIT_FAILED',
  FEEDBACK_DUPLICATE: 'FEEDBACK_DUPLICATE',
  NEWSLETTER_CONFIRM_INVALID: 'NEWSLETTER_CONFIRM_INVALID',
  NEWSLETTER_UNSUBSCRIBE_INVALID: 'NEWSLETTER_UNSUBSCRIBE_INVALID',
  // Client-minted codes for the OPAQUE auth flows and the account/security
  // modals. These never appear on the wire — they are surfaced only from the
  // web client's own catch/guard branches — but they live in the same
  // exhaustive registry so every client error path maps through one code→copy
  // home rather than a hardcoded string.
  LOGIN_FAILED: 'LOGIN_FAILED',
  REGISTRATION_FAILED: 'REGISTRATION_FAILED',
  ENCRYPTION_NOT_SETUP: 'ENCRYPTION_NOT_SETUP',
  CREDENTIAL_UPDATE_FAILED: 'CREDENTIAL_UPDATE_FAILED',
  ACCOUNT_KEY_NOT_AVAILABLE: 'ACCOUNT_KEY_NOT_AVAILABLE',
  DISABLE_2FA_INIT_FAILED: 'DISABLE_2FA_INIT_FAILED',
  TWO_FACTOR_VERIFICATION_FAILED: 'TWO_FACTOR_VERIFICATION_FAILED',
  TWO_FACTOR_SETUP_FAILED: 'TWO_FACTOR_SETUP_FAILED',
  EMAIL_VERIFICATION_FAILED: 'EMAIL_VERIFICATION_FAILED',
  CUSTOM_INSTRUCTIONS_SAVE_FAILED: 'CUSTOM_INSTRUCTIONS_SAVE_FAILED',
  CREDENTIAL_VERIFICATION_FAILED: 'CREDENTIAL_VERIFICATION_FAILED',
  RECOVERY_MATERIAL_SAVE_FAILED: 'RECOVERY_MATERIAL_SAVE_FAILED',
  RECOVERY_PHRASE_GENERATION_FAILED: 'RECOVERY_PHRASE_GENERATION_FAILED',
} as const satisfies Record<string, string>;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const ERROR_CODE_VALUES = Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

/** Zod schema for the closed code set (wire validation). */
export const errorCodeSchema = z.enum(ERROR_CODE_VALUES);

/**
 * Compile-exhaustive code→user-message map: the `satisfies
 * Record<ErrorCode, string>` clause makes adding a code without a message
 * a type error.
 */
export const ERROR_MESSAGES = {
  VALIDATION: 'Invalid input. Please check your data and try again.',
  UNAUTHORIZED: 'You are not logged in. Please log in and try again.',
  FORBIDDEN: "You don't have permission to do this.",
  NOT_FOUND: "The item you're looking for doesn't exist.",
  CONFLICT: 'This action conflicts with the current state. Please refresh and try again.',
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
  TIMEOUT: 'The operation took too long and was stopped. Please try again.',
  UNAVAILABLE: 'This service is temporarily unavailable. Please try again later.',
  INTERNAL: 'Something went wrong. Please try again later.',
  CONCURRENT_RUN:
    'This conversation is already generating a response. Wait for it to finish, then try again.',
  INSUFFICIENT_ADMISSION:
    'Your balance or budget is too low to start this request. Add credits or adjust your selection.',
  ADMISSION_UNAVAILABLE: 'Paid requests are temporarily unavailable. Please try again shortly.',
  ZDR_REFUSED: 'This model does not meet our zero-data-retention requirements and cannot be used.',
  UNSUPPORTED_MODALITY: 'This content type is not supported yet.',
  VERSION_MISMATCH: 'Your app is out of date. Please update to continue.',
  BUILD_NOT_FOUND: "That app version isn't available for download.",
  SERVICE_UNAVAILABLE: 'This service is temporarily unavailable. Please try again later.',
  CSRF_REJECTED: 'Request rejected for security reasons. Please refresh and try again.',
  PAYLOAD_TOO_LARGE: 'Your request is too large. Please shorten it and try again.',
  IDEMPOTENCY_KEY_REQUIRED: 'Something went wrong with your request. Please try again.',
  IDEMPOTENCY_BODY_MISMATCH: 'This request conflicts with an earlier one. Please try again.',
  REQUEST_IN_PROGRESS: 'This request is already being processed. Please wait a moment.',
  AUTH_FAILED: 'Incorrect username, email, or password. Please try again.',
  ACCOUNT_LOCKED: 'Your account is locked. Contact support for help.',
  EMAIL_NOT_VERIFIED:
    'Please verify your email address before signing in. Check your inbox for the link.',
  EMAIL_TAKEN: 'An account with this email already exists.',
  USERNAME_TAKEN: 'This username is taken. Please choose another.',
  NO_PENDING_LOGIN: 'Your login attempt expired. Please try again.',
  NO_PENDING_REGISTRATION: 'Your signup attempt expired. Please try again.',
  INVALID_TOTP_CODE: 'That code is incorrect or has expired. Please try again.',
  TOTP_CODE_REQUIRED: 'Enter your two-factor authentication code to continue.',
  TOTP_ALREADY_ENABLED: 'Two-factor authentication is already enabled.',
  TOTP_NOT_ENABLED: 'Two-factor authentication is not enabled.',
  NO_PENDING_2FA_SETUP: 'Your two-factor setup expired. Please start again.',
  NO_PENDING_STEP_UP: 'Your confirmation expired. Please try again.',
  NO_PENDING_RECOVERY: 'Your recovery attempt expired. Please try again.',
  INVALID_CONFIRMATION_PHRASE: "That confirmation phrase doesn't match. Please type it exactly.",
  INVALID_VERIFICATION_TOKEN: 'This verification link is invalid or has expired.',
  LOGIN_TOKEN_INVALID: 'This login link has expired or already been used.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Please wait and try again.',
  STALE_EPOCH: 'The conversation keys changed. Refresh and try again.',
  WRAP_SET_MISMATCH: 'The key update does not match the current members. Refresh and try again.',
  MEMBER_LIMIT_REACHED: 'This conversation has reached its member limit.',
  ALREADY_MEMBER: 'This user is already a member of the conversation.',
  ROTATION_REQUIRED: 'Leaving this conversation requires a key rotation. Please try again.',
  CANNOT_REMOVE_OWNER: 'The owner of a conversation cannot be removed.',
  CANNOT_REMOVE_SELF: 'You cannot remove yourself. Use leave instead.',
  CANNOT_CHANGE_OWN_PRIVILEGE: 'You cannot change your own privilege.',
  PRIVILEGE_INSUFFICIENT: "You can't set a privilege at or above your own level.",
  FORK_LIMIT_REACHED: 'This conversation has reached its branch limit.',
  FORK_NAME_TAKEN: 'A branch with this name already exists. Please choose another.',
  FORK_TIP_CONFLICT: 'Someone else updated this branch. Refresh and try again.',
  REGENERATION_BLOCKED_BY_OTHER_USER:
    "Another member replied after this message, so it can't be regenerated or edited.",
  FORK_ID_REQUIRED: 'This conversation has branches. Choose a branch, then try again.',
  AUTHENTICATED_ON_TRIAL: 'Signed-in users should use the main chat, not the trial.',
  TRIAL_LIMIT_REACHED: "You've reached today's free trial limit. Sign up to keep chatting.",
  TRIAL_CAPACITY_REACHED:
    "HushBox's free trial is at capacity for today. Sign up to keep chatting, or try again tomorrow.",
  FEATURE_REQUIRES_AUTH: 'This feature requires an account. Please sign up or log in.',
  TRIAL_MESSAGE_TOO_EXPENSIVE:
    'This message is too costly for the free trial. Try a shorter message or sign up to keep chatting.',
  PREMIUM_REQUIRES_ACCOUNT:
    'This model is available with an account. Sign up to chat with premium models.',
  MEDIA_TRIAL_BLOCKED:
    'The free trial supports text models only. Sign up to generate images and video.',
  MODEL_TIER_LOCKED: 'This premium model needs credits. Add funds to your balance to use it.',
  MODEL_DISABLED: 'This model is temporarily unavailable. Please choose a different model.',
  DUPLICATE_MESSAGE: 'This message was already sent. Refresh to see the latest state.',
  FEEDBACK_SUBMIT_FAILED: "We couldn't send your feedback. Please try again.",
  FEEDBACK_DUPLICATE: "You've already sent this feedback.",
  NEWSLETTER_CONFIRM_INVALID:
    'That confirmation link is invalid or has expired. Sign up again to get a fresh one.',
  NEWSLETTER_UNSUBSCRIBE_INVALID:
    'That unsubscribe link is invalid or has already been used. If you keep receiving emails, use the unsubscribe link in the newest one.',
  LOGIN_FAILED: 'Login failed. Please check your credentials and try again.',
  REGISTRATION_FAILED: 'Registration failed. Please try again.',
  ENCRYPTION_NOT_SETUP: 'Your account encryption is not configured. Please contact support.',
  CREDENTIAL_UPDATE_FAILED: 'Password change failed. Please try again.',
  ACCOUNT_KEY_NOT_AVAILABLE: 'Your encryption key is unavailable. Please log out and log back in.',
  DISABLE_2FA_INIT_FAILED: 'Failed to start two-factor disable. Please try again.',
  TWO_FACTOR_VERIFICATION_FAILED: 'Two-factor verification failed. Please try again.',
  TWO_FACTOR_SETUP_FAILED: 'Failed to initialize two-factor setup. Please try again.',
  EMAIL_VERIFICATION_FAILED: 'Email verification failed. Please try again or request a new link.',
  CUSTOM_INSTRUCTIONS_SAVE_FAILED: 'Failed to save custom instructions. Please try again.',
  CREDENTIAL_VERIFICATION_FAILED: 'Failed to verify password. Please try again.',
  RECOVERY_MATERIAL_SAVE_FAILED: 'Failed to save recovery material. Please try again.',
  RECOVERY_PHRASE_GENERATION_FAILED: 'Failed to generate recovery phrase. Please try again.',
} as const satisfies Record<ErrorCode, string>;

const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Maps a machine-readable code to a branded user-facing message. Accepts
 * `ErrorCode` (autocomplete) or any string (network-parsed codes); unknown
 * codes return the generic fallback.
 */
export function friendlyErrorMessage(code: ErrorCode | (string & {})): UserFacingMessage {
  const message = (ERROR_MESSAGES as Record<string, string>)[code] ?? FALLBACK_MESSAGE;
  return message as UserFacingMessage;
}

/**
 * Route-level map from the lower-case `DomainError` taxonomy (the API
 * lib's `Result` error channel) to wire codes. The taxonomy union is
 * re-stated here as map keys because packages cannot import from apps; the
 * API lib consumes this map and its own `Record<DomainErrorCode, …>` check
 * keeps the two in sync at compile time.
 */
export const DOMAIN_ERROR_CODE_TO_WIRE_CODE = {
  validation: ERROR_CODES.VALIDATION,
  unauthorized: ERROR_CODES.UNAUTHORIZED,
  forbidden: ERROR_CODES.FORBIDDEN,
  not_found: ERROR_CODES.NOT_FOUND,
  conflict: ERROR_CODES.CONFLICT,
  rate_limited: ERROR_CODES.RATE_LIMITED,
  timeout: ERROR_CODES.TIMEOUT,
  unavailable: ERROR_CODES.UNAVAILABLE,
} as const satisfies Record<string, ErrorCode>;

/**
 * The API error response: `{ code, details? }`, strictly — a message
 * field on the wire is a contract violation (messages are client-mapped).
 */
export const errorResponseSchema = z.strictObject({
  code: errorCodeSchema,
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
