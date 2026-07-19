import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_CODE_TO_WIRE_CODE,
  friendlyErrorMessage,
  ERROR_CODES,
  ERROR_MESSAGES,
  errorCodeSchema,
  errorResponseSchema,
} from './error-codes.js';
import type { ErrorCode } from './error-codes.js';

describe('ERROR_CODES', () => {
  it('covers the eight DomainError taxonomy codes', () => {
    const taxonomy = [
      'VALIDATION',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'RATE_LIMITED',
      'TIMEOUT',
      'UNAVAILABLE',
    ];
    for (const code of taxonomy) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('names the backend domain-specific codes', () => {
    const planCodes = [
      'CONCURRENT_RUN',
      'INSUFFICIENT_ADMISSION',
      'ADMISSION_UNAVAILABLE',
      'ZDR_REFUSED',
      'UNSUPPORTED_MODALITY',
      'VERSION_MISMATCH',
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_BODY_MISMATCH',
      'REQUEST_IN_PROGRESS',
      'INTERNAL',
    ];
    for (const code of planCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('names the identity auth-flow codes', () => {
    const identityCodes = [
      'AUTH_FAILED',
      'ACCOUNT_LOCKED',
      'EMAIL_TAKEN',
      'USERNAME_TAKEN',
      'NO_PENDING_LOGIN',
      'NO_PENDING_REGISTRATION',
      'LOGIN_TOKEN_INVALID',
    ];
    for (const code of identityCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('names the account-deletion confirmation and TOTP-gate codes', () => {
    for (const code of ['INVALID_CONFIRMATION_PHRASE', 'TOTP_CODE_REQUIRED']) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
    expect(ERROR_MESSAGES.INVALID_CONFIRMATION_PHRASE).not.toBe(ERROR_MESSAGES.TOTP_CODE_REQUIRED);
  });

  it('names the regenerate guard code', () => {
    expect(Object.values(ERROR_CODES)).toContain('REGENERATION_BLOCKED_BY_OTHER_USER');
  });

  it('names the feedback-submit failure code with its own copy', () => {
    expect(ERROR_CODES.FEEDBACK_SUBMIT_FAILED).toBe('FEEDBACK_SUBMIT_FAILED');
    expect(friendlyErrorMessage('FEEDBACK_SUBMIT_FAILED')).toBe(
      ERROR_MESSAGES.FEEDBACK_SUBMIT_FAILED
    );
    expect(friendlyErrorMessage('FEEDBACK_SUBMIT_FAILED')).not.toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('names the feedback-duplicate code with its own calm copy', () => {
    expect(ERROR_CODES.FEEDBACK_DUPLICATE).toBe('FEEDBACK_DUPLICATE');
    expect(friendlyErrorMessage('FEEDBACK_DUPLICATE')).toBe(ERROR_MESSAGES.FEEDBACK_DUPLICATE);
    // The duplicate refusal is not the generic submit failure: it tells the
    // user the note already landed, so it carries its own distinct copy.
    expect(ERROR_MESSAGES.FEEDBACK_DUPLICATE).not.toBe(ERROR_MESSAGES.FEEDBACK_SUBMIT_FAILED);
    expect(friendlyErrorMessage('FEEDBACK_DUPLICATE')).not.toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('names the admin model kill-switch code', () => {
    expect(ERROR_CODES.MODEL_DISABLED).toBe('MODEL_DISABLED');
    expect(friendlyErrorMessage('MODEL_DISABLED')).toBe(ERROR_MESSAGES.MODEL_DISABLED);
  });

  it('names the CSRF Origin-rejection code (edge middleware)', () => {
    expect(ERROR_CODES.CSRF_REJECTED).toBe('CSRF_REJECTED');
    expect(ERROR_MESSAGES.CSRF_REJECTED).toBeTruthy();
  });

  it('names the platform-surface codes (OTA download, roadmap proxy)', () => {
    expect(ERROR_CODES.BUILD_NOT_FOUND).toBe('BUILD_NOT_FOUND');
    expect(ERROR_MESSAGES.BUILD_NOT_FOUND).toBeTruthy();
    expect(ERROR_CODES.SERVICE_UNAVAILABLE).toBe('SERVICE_UNAVAILABLE');
    expect(ERROR_MESSAGES.SERVICE_UNAVAILABLE).toBeTruthy();
  });

  it('names the trial-surface codes', () => {
    const trialCodes = [
      'AUTHENTICATED_ON_TRIAL',
      'TRIAL_LIMIT_REACHED',
      'TRIAL_CAPACITY_REACHED',
      'FEATURE_REQUIRES_AUTH',
    ];
    for (const code of trialCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('names the trial pre-run refusal codes', () => {
    const refusalCodes = [
      'TRIAL_MESSAGE_TOO_EXPENSIVE',
      'PREMIUM_REQUIRES_ACCOUNT',
      'MEDIA_TRIAL_BLOCKED',
    ];
    for (const code of refusalCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('names the paid premium-tier gate code', () => {
    expect(Object.values(ERROR_CODES)).toContain('MODEL_TIER_LOCKED');
    expect(ERROR_MESSAGES.MODEL_TIER_LOCKED).toBeTruthy();
  });

  it('separates the paid tier lock from the trial premium refusal', () => {
    // MODEL_TIER_LOCKED gates an authenticated caller with no balance from a
    // premium model on a paid turn; PREMIUM_REQUIRES_ACCOUNT is the trial's
    // sign-up prompt. Distinct codes carry distinct copy.
    expect(ERROR_CODES.MODEL_TIER_LOCKED).not.toBe(ERROR_CODES.PREMIUM_REQUIRES_ACCOUNT);
    expect(ERROR_MESSAGES.MODEL_TIER_LOCKED).not.toBe(ERROR_MESSAGES.PREMIUM_REQUIRES_ACCOUNT);
  });

  it('gives each trial pre-run refusal its own distinct copy', () => {
    const messages = [
      ERROR_MESSAGES.TRIAL_MESSAGE_TOO_EXPENSIVE,
      ERROR_MESSAGES.PREMIUM_REQUIRES_ACCOUNT,
      ERROR_MESSAGES.MEDIA_TRIAL_BLOCKED,
      ERROR_MESSAGES.TRIAL_LIMIT_REACHED,
      ERROR_MESSAGES.AUTHENTICATED_ON_TRIAL,
    ];
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('separates the daily-capacity refusal from the personal 5/day quota', () => {
    // TRIAL_CAPACITY_REACHED is the shared daily-spend ceiling (an
    // admission refusal, like INSUFFICIENT_ADMISSION); TRIAL_LIMIT_REACHED is
    // the caller's own 5/day quota. Distinct codes carry distinct copy.
    expect(ERROR_CODES.TRIAL_CAPACITY_REACHED).not.toBe(ERROR_CODES.TRIAL_LIMIT_REACHED);
    expect(ERROR_MESSAGES.TRIAL_CAPACITY_REACHED).not.toBe(ERROR_MESSAGES.TRIAL_LIMIT_REACHED);
  });

  it('names the user-only message duplicate code (runless Pattern-A send)', () => {
    expect(ERROR_CODES.DUPLICATE_MESSAGE).toBe('DUPLICATE_MESSAGE');
    expect(ERROR_MESSAGES.DUPLICATE_MESSAGE).toBeTruthy();
    // A duplicate messageId is not the generic CONFLICT: the client's recovery
    // is a refresh, not a retry, so it carries its own copy.
    expect(ERROR_MESSAGES.DUPLICATE_MESSAGE).not.toBe(ERROR_MESSAGES.CONFLICT);
  });

  it('names the client-minted auth-flow and modal codes with distinct copy', () => {
    const clientCodes = [
      'LOGIN_FAILED',
      'REGISTRATION_FAILED',
      'ENCRYPTION_NOT_SETUP',
      'CREDENTIAL_UPDATE_FAILED',
      'ACCOUNT_KEY_NOT_AVAILABLE',
      'DISABLE_2FA_INIT_FAILED',
      'TWO_FACTOR_VERIFICATION_FAILED',
      'TWO_FACTOR_SETUP_FAILED',
      'EMAIL_VERIFICATION_FAILED',
      'CUSTOM_INSTRUCTIONS_SAVE_FAILED',
      'CREDENTIAL_VERIFICATION_FAILED',
      'RECOVERY_MATERIAL_SAVE_FAILED',
      'RECOVERY_PHRASE_GENERATION_FAILED',
    ] as const;
    for (const code of clientCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
      // Each maps to exactly one non-empty message home, no fallback.
      expect(friendlyErrorMessage(code)).toBe(ERROR_MESSAGES[code]);
      expect(friendlyErrorMessage(code)).not.toBe('Something went wrong. Please try again.');
    }
    const messages = clientCodes.map((code) => ERROR_MESSAGES[code]);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('uses each key as its own value (machine-readable constants)', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(key).toBe(value);
    }
  });
});

describe('media-modality and streaming-failure codes', () => {
  const mediaCodes = [
    'UNSUPPORTED_MODALITY',
    'UNSUPPORTED_RESOLUTION',
    'UNSUPPORTED_DURATION',
    'MISSING_MODALITY_CONFIG',
    'AUDIO_DISABLED',
  ] as const;
  const streamingCodes = ['CONTENT_POLICY', 'CONTEXT_LENGTH_EXCEEDED', 'NETWORK_ERROR'] as const;

  it('registers every media-modality and streaming code in the closed set', () => {
    for (const code of [...mediaCodes, ...streamingCodes]) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('gives each new code its own non-fallback copy', () => {
    const fallback = friendlyErrorMessage('DEFINITELY_UNKNOWN_CODE');
    for (const code of [...mediaCodes, ...streamingCodes]) {
      expect(friendlyErrorMessage(code)).toBe(ERROR_MESSAGES[code]);
      expect(friendlyErrorMessage(code)).not.toBe(fallback);
    }
  });

  it('distinguishes the resolution and duration refusals', () => {
    expect(ERROR_MESSAGES.UNSUPPORTED_RESOLUTION).not.toBe(ERROR_MESSAGES.UNSUPPORTED_DURATION);
  });
});

describe('ERROR_MESSAGES', () => {
  it('has a user-facing message for every code (runtime mirror of the compile-time guarantee)', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  it('is compile-time exhaustive: a missing code fails the type checker', () => {
    // The map's declared type is Record<ErrorCode, string>; assigning an
    // object missing a key is a compile error. This proves the mechanism.
    const incomplete = { VALIDATION: 'x' };
    // @ts-expect-error -- missing every other ErrorCode key
    const map: Record<ErrorCode, string> = incomplete;
    expect(map.VALIDATION).toBe('x');
  });
});

describe('friendlyErrorMessage', () => {
  it('maps a known code to its message', () => {
    expect(friendlyErrorMessage('CONCURRENT_RUN')).toBe(ERROR_MESSAGES.CONCURRENT_RUN);
  });

  it('falls back to a generic message for unknown codes', () => {
    expect(friendlyErrorMessage('NOT_A_CODE')).toBe('Something went wrong. Please try again.');
  });
});

describe('DOMAIN_ERROR_CODE_TO_WIRE_CODE', () => {
  it('maps each lower-case taxonomy code to a defined wire code with a message', () => {
    for (const wireCode of Object.values(DOMAIN_ERROR_CODE_TO_WIRE_CODE)) {
      expect(ERROR_MESSAGES[wireCode]).toBeTruthy();
    }
  });

  it('maps the taxonomy one-to-one onto the eight base codes', () => {
    expect(DOMAIN_ERROR_CODE_TO_WIRE_CODE).toEqual({
      validation: 'VALIDATION',
      unauthorized: 'UNAUTHORIZED',
      forbidden: 'FORBIDDEN',
      not_found: 'NOT_FOUND',
      conflict: 'CONFLICT',
      rate_limited: 'RATE_LIMITED',
      timeout: 'TIMEOUT',
      unavailable: 'UNAVAILABLE',
    });
  });
});

describe('errorCodeSchema', () => {
  it('accepts a known code', () => {
    expect(errorCodeSchema.parse('ZDR_REFUSED')).toBe('ZDR_REFUSED');
  });

  it('rejects an unknown code', () => {
    expect(errorCodeSchema.safeParse('NOPE').success).toBe(false);
  });
});

describe('errorResponseSchema', () => {
  it('accepts code-only responses', () => {
    expect(errorResponseSchema.parse({ code: 'VALIDATION' })).toEqual({ code: 'VALIDATION' });
  });

  it('accepts optional details', () => {
    const parsed = errorResponseSchema.parse({
      code: 'VERSION_MISMATCH',
      details: { otaUrl: 'https://example.test' },
    });
    expect(parsed.details).toEqual({ otaUrl: 'https://example.test' });
  });

  it('rejects a message field (codes only on the wire — messages map client-side)', () => {
    expect(errorResponseSchema.safeParse({ code: 'VALIDATION', message: 'nope' }).success).toBe(
      false
    );
  });

  it('rejects an unknown code', () => {
    expect(errorResponseSchema.safeParse({ code: 'WHAT' }).success).toBe(false);
  });
});

describe('newsletter error codes', () => {
  const newsletterCodes = ['NEWSLETTER_CONFIRM_INVALID', 'NEWSLETTER_UNSUBSCRIBE_INVALID'] as const;

  it('are registered in the closed code set', () => {
    for (const code of newsletterCodes) {
      expect(Object.values(ERROR_CODES)).toContain(code);
    }
  });

  it('each map to a non-fallback friendly message', () => {
    const fallback = friendlyErrorMessage('DEFINITELY_UNKNOWN_CODE');
    for (const code of newsletterCodes) {
      const message = friendlyErrorMessage(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toBe(fallback);
    }
  });
});
