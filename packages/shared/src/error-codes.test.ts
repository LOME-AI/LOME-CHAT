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

  it('names the regenerate guard code', () => {
    expect(Object.values(ERROR_CODES)).toContain('REGENERATION_BLOCKED_BY_OTHER_USER');
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

  it('uses each key as its own value (machine-readable constants)', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(key).toBe(value);
    }
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
