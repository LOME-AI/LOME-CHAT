import { describe, it, expect } from 'vitest';
import { ROUTES, formatLockoutMessage, friendlyErrorMessage } from '@hushbox/shared';
import { trialRefusalFor } from '@/lib/trial-refusals';
import { ChatRequestError } from '@/lib/chat-request-error';

const CTA = `[Sign up free](${ROUTES.SIGNUP})`;

describe('trialRefusalFor', () => {
  describe('quota-exhausted refusals disable the composer', () => {
    it.each(['TRIAL_LIMIT_REACHED', 'DAILY_LIMIT_EXCEEDED'])(
      'maps %s to the shared trial-limit message with a sign-up CTA',
      (code) => {
        const refusal = trialRefusalFor(new ChatRequestError(code));

        expect(refusal).toEqual({
          content: `${friendlyErrorMessage('TRIAL_LIMIT_REACHED')}\n\n${CTA}`,
          disablesComposer: true,
        });
      }
    );

    it('maps TRIAL_CAPACITY_REACHED to the shared capacity message with a sign-up CTA', () => {
      const refusal = trialRefusalFor(new ChatRequestError('TRIAL_CAPACITY_REACHED'));

      expect(refusal).toEqual({
        content: `${friendlyErrorMessage('TRIAL_CAPACITY_REACHED')}\n\n${CTA}`,
        disablesComposer: true,
      });
    });

    it('maps AUTHENTICATED_ON_TRIAL to an into-the-app link instead of the sign-up CTA', () => {
      const refusal = trialRefusalFor(
        new ChatRequestError('AUTHENTICATED_ON_TRIAL', undefined, 403)
      );

      expect(refusal).toEqual({
        content: `${friendlyErrorMessage('AUTHENTICATED_ON_TRIAL')}\n\n[Go to your chats](${ROUTES.CHAT})`,
        disablesComposer: true,
      });
    });
  });

  describe('recoverable refusals keep the composer enabled', () => {
    it.each([
      'TRIAL_MESSAGE_TOO_EXPENSIVE',
      'PREMIUM_REQUIRES_ACCOUNT',
      'MEDIA_TRIAL_BLOCKED',
      'FEATURE_REQUIRES_AUTH',
    ] as const)('maps %s to its shared message with a sign-up CTA', (code) => {
      const refusal = trialRefusalFor(new ChatRequestError(code));

      expect(refusal).toEqual({
        content: `${friendlyErrorMessage(code)}\n\n${CTA}`,
        disablesComposer: false,
      });
    });

    it('maps RATE_LIMITED without retry details to the shared rate-limit message', () => {
      const refusal = trialRefusalFor(new ChatRequestError('RATE_LIMITED'));

      expect(refusal).toEqual({
        content: `${friendlyErrorMessage('RATE_LIMITED')}\n\n${CTA}`,
        disablesComposer: false,
      });
    });

    it('maps RATE_LIMITED with retryAfterSeconds to the countdown message', () => {
      const refusal = trialRefusalFor(
        new ChatRequestError('RATE_LIMITED', { retryAfterSeconds: 12 })
      );

      expect(refusal).toEqual({
        content: `${formatLockoutMessage(12)}\n\n${CTA}`,
        disablesComposer: false,
      });
    });

    it('falls back to the shared rate-limit message when the error has no details field', () => {
      const refusal = trialRefusalFor({ code: 'RATE_LIMITED' });

      expect(refusal?.content).toBe(`${friendlyErrorMessage('RATE_LIMITED')}\n\n${CTA}`);
    });

    it('ignores a non-numeric retryAfterSeconds detail', () => {
      const refusal = trialRefusalFor(
        new ChatRequestError('RATE_LIMITED', { retryAfterSeconds: 'soon' as unknown as number })
      );

      expect(refusal?.content).toBe(`${friendlyErrorMessage('RATE_LIMITED')}\n\n${CTA}`);
    });
  });

  describe('non-refusals return null', () => {
    it('returns null for an unmapped code', () => {
      expect(trialRefusalFor(new ChatRequestError('INTERNAL'))).toBeNull();
    });

    it('returns null for an error without a code', () => {
      expect(trialRefusalFor(new Error('Network error'))).toBeNull();
    });

    it('returns null for a non-object error', () => {
      expect(trialRefusalFor('boom')).toBeNull();
    });

    it('returns null for a non-string code', () => {
      expect(trialRefusalFor({ code: 429 })).toBeNull();
    });
  });
});
