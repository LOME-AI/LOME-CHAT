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

type RefusalBuilder = (error: unknown) => TrialRefusal;

/** The session is done for the day: nothing the user retries will succeed. */
const personalQuotaSpent: RefusalBuilder = () => ({
  content: withSignupCta(friendlyErrorMessage('TRIAL_LIMIT_REACHED')),
  disablesComposer: true,
});

function signupNudge(code: Parameters<typeof friendlyErrorMessage>[0]): RefusalBuilder {
  return () => ({ content: withSignupCta(friendlyErrorMessage(code)), disablesComposer: false });
}

// A Map, not a plain object: the code string comes off the wire, and a plain
// object lookup would resolve prototype keys ('constructor') to functions.
const REFUSAL_BUILDERS = new Map<string, RefusalBuilder>([
  ['TRIAL_LIMIT_REACHED', personalQuotaSpent],
  // DAILY_LIMIT_EXCEEDED is the current wire's name for the same personal
  // daily-quota refusal; both source the one shared trial-limit message.
  ['DAILY_LIMIT_EXCEEDED', personalQuotaSpent],
  [
    'TRIAL_CAPACITY_REACHED',
    () => ({
      content: withSignupCta(friendlyErrorMessage('TRIAL_CAPACITY_REACHED')),
      disablesComposer: true,
    }),
  ],
  // An authenticated user has no business composing on the trial page (the
  // page already redirects them; this is the belt-and-braces path), and they
  // already have an account — link them into the app, not to sign-up.
  [
    'AUTHENTICATED_ON_TRIAL',
    () => ({
      content: customUserMessage(
        `${friendlyErrorMessage('AUTHENTICATED_ON_TRIAL')}\n\n[Go to your chats](${ROUTES.CHAT})`
      ),
      disablesComposer: true,
    }),
  ],
  ['TRIAL_MESSAGE_TOO_EXPENSIVE', signupNudge('TRIAL_MESSAGE_TOO_EXPENSIVE')],
  ['PREMIUM_REQUIRES_ACCOUNT', signupNudge('PREMIUM_REQUIRES_ACCOUNT')],
  ['MEDIA_TRIAL_BLOCKED', signupNudge('MEDIA_TRIAL_BLOCKED')],
  ['FEATURE_REQUIRES_AUTH', signupNudge('FEATURE_REQUIRES_AUTH')],
  [
    'RATE_LIMITED',
    (error) => {
      const retryAfterSeconds = extractRetryAfterSeconds(error);
      const message =
        retryAfterSeconds === undefined
          ? friendlyErrorMessage('RATE_LIMITED')
          : formatLockoutMessage(retryAfterSeconds);
      return { content: withSignupCta(message), disablesComposer: false };
    },
  ],
]);

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
  if (code === undefined) return null;
  const build = REFUSAL_BUILDERS.get(code);
  return build === undefined ? null : build(error);
}
