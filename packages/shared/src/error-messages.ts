/**
 * The `UserFacingMessage` brand plus helpers that produce one without going
 * through the code→copy map.
 *
 * The single source of truth for code→message copy is `error-codes.ts`
 * (`friendlyErrorMessage`). This module holds only the branded-string type and
 * the two producers that mint a message from something other than a code: a
 * hand-written string (`customUserMessage`) and a formatted lockout countdown
 * (`formatLockoutMessage`).
 */

declare const __brand: unique symbol;

/**
 * A string that has been validated as a user-facing message.
 *
 * Produced by `friendlyErrorMessage()` (from an error code), or by
 * `customUserMessage()` / `formatLockoutMessage()` (from a hand-written or
 * formatted string).
 *
 * `createChatError()` requires this type, preventing raw strings
 * from being passed without explicit mapping.
 */
export type UserFacingMessage = string & { readonly [__brand]: 'UserFacingMessage' };

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
