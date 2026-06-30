import { match } from 'ts-pattern';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_CODES,
  conflictError,
  forbiddenError,
  isDomainError,
  notFoundError,
  rateLimitedError,
  timeoutError,
  unauthorizedError,
  unavailableError,
  validationError,
} from './domain-error.js';
import type { DomainError, DomainErrorCode } from './domain-error.js';

// Compile-time closed-set check: `satisfies` fails if a factory is missing
// for any code or if a factory's code falls outside the taxonomy.
const FACTORY_BY_CODE = {
  validation: validationError,
  unauthorized: unauthorizedError,
  forbidden: forbiddenError,
  not_found: notFoundError,
  conflict: conflictError,
  rate_limited: rateLimitedError,
  timeout: timeoutError,
  unavailable: unavailableError,
} satisfies Record<DomainErrorCode, (message: string, cause?: unknown) => DomainError>;

describe('domain error factories', () => {
  it.each(DOMAIN_ERROR_CODES)('factory for %s stamps its code discriminant', (code) => {
    const error = FACTORY_BY_CODE[code]('boom');
    expect(error.code).toBe(code);
  });

  it('carries the given message', () => {
    expect(validationError('email is malformed').message).toBe('email is malformed');
  });

  it('attaches the cause when provided', () => {
    const cause = new Error('socket hang up');
    expect(unavailableError('upstream failed', cause).cause).toBe(cause);
  });

  it('omits the cause key when no cause is given', () => {
    expect('cause' in notFoundError('missing')).toBe(false);
  });
});

describe('isDomainError', () => {
  it.each(DOMAIN_ERROR_CODES)('accepts a factory-built %s error', (code) => {
    expect(isDomainError(FACTORY_BY_CODE[code]('boom'))).toBe(true);
  });

  it('rejects null', () => {
    expect(isDomainError(null)).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isDomainError('timeout')).toBe(false);
  });

  it('rejects a plain Error', () => {
    expect(isDomainError(new Error('boom'))).toBe(false);
  });

  it('rejects an object whose code is outside the taxonomy', () => {
    expect(isDomainError({ code: 'mystery', message: 'boom' })).toBe(false);
  });

  it('rejects an object with a taxonomy code but no message', () => {
    expect(isDomainError({ code: 'timeout' })).toBe(false);
  });
});

describe('ts-pattern matching', () => {
  it('matches every kind exhaustively', () => {
    const toCode = (error: DomainError): DomainErrorCode =>
      match(error)
        .with({ code: 'validation' }, (e) => e.code)
        .with({ code: 'unauthorized' }, (e) => e.code)
        .with({ code: 'forbidden' }, (e) => e.code)
        .with({ code: 'not_found' }, (e) => e.code)
        .with({ code: 'conflict' }, (e) => e.code)
        .with({ code: 'rate_limited' }, (e) => e.code)
        .with({ code: 'timeout' }, (e) => e.code)
        .with({ code: 'unavailable' }, (e) => e.code)
        .exhaustive();

    for (const code of DOMAIN_ERROR_CODES) {
      expect(toCode(FACTORY_BY_CODE[code]('boom'))).toBe(code);
    }
  });

  it('compiler rejects a non-exhaustive match and runtime throws on the unhandled kind', () => {
    const partial = (error: DomainError): string =>
      match(error)
        .with({ code: 'validation' }, () => 'validation')
        // @ts-expect-error -- exhaustive() must be a compile error while seven kinds are unhandled; if ts-pattern ever stops catching this, the unused directive fails typecheck
        .exhaustive();

    expect(() => partial(timeoutError('late'))).toThrow();
  });
});
