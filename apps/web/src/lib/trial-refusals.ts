import {
  ROUTES,
  customUserMessage,
  formatLockoutMessage,
  friendlyErrorMessage,
} from '@hushbox/shared';
import type { UserFacingMessage } from '@hushbox/shared';

/** A trial stream refusal resolved to user-facing copy and composer policy. */
export interface TrialRefusal {
  content: UserFacingMessage;
  /**
   * True when nothing the user can do this session will succeed (personal
   * daily quota spent, or the global trial pool is exhausted for the day).
   */
  disablesComposer: boolean;
}

function withSignupCta(message: string): UserFacingMessage {
  return customUserMessage(`${message}\n\n[Sign up free](${ROUTES.SIGNUP})`);
}

function extractCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === 'string' ? code : undefined;
}

function extractRetryAfterSeconds(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('details' in error)) return undefined;
  const { details } = error as { details: unknown };
  if (typeof details !== 'object' || details === null || !('retryAfterSeconds' in details)) {
    return undefined;
  }
  const { retryAfterSeconds } = details as { retryAfterSeconds: unknown };
  return typeof retryAfterSeconds === 'number' ? retryAfterSeconds : undefined;
}

/**
 * Maps a trial stream error to conversion-oriented refusal copy, keyed on the
 * wire code carried by the thrown error. Both wire vocabularies for the trial
 * refusals — the endpoint's current code names and the shared ERROR_CODES
 * names — resolve here, so the mapping is independent of which API serves the
 * stream. Returns null for anything that is not a known refusal (callers fall
 * back to the generic error path).
 */
export function trialRefusalFor(error: unknown): TrialRefusal | null {
  const code = extractCode(error);
  switch (code) {
    // DAILY_LIMIT_EXCEEDED is the current wire's name for the same personal
    // daily-quota refusal; both source the one shared trial-limit message.
    case 'TRIAL_LIMIT_REACHED':
    case 'DAILY_LIMIT_EXCEEDED': {
      return {
        content: withSignupCta(friendlyErrorMessage('TRIAL_LIMIT_REACHED')),
        disablesComposer: true,
      };
    }
    case 'TRIAL_CAPACITY_REACHED': {
      return { content: withSignupCta(friendlyErrorMessage(code)), disablesComposer: true };
    }
    case 'TRIAL_MESSAGE_TOO_EXPENSIVE':
    case 'PREMIUM_REQUIRES_ACCOUNT':
    case 'MEDIA_TRIAL_BLOCKED':
    case 'FEATURE_REQUIRES_AUTH': {
      return { content: withSignupCta(friendlyErrorMessage(code)), disablesComposer: false };
    }
    case 'RATE_LIMITED': {
      const retryAfterSeconds = extractRetryAfterSeconds(error);
      const message =
        retryAfterSeconds === undefined
          ? friendlyErrorMessage(code)
          : formatLockoutMessage(retryAfterSeconds);
      return { content: withSignupCta(message), disablesComposer: false };
    }
    default: {
      return null;
    }
  }
}
