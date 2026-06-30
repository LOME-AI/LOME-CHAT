import { describe, it, expect } from 'vitest';
import { domainErrorBody, domainErrorStatus } from './wire.js';
import type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';

function errorOf(code: DomainErrorCode): DomainError {
  return { code, message: 'operator-safe message' };
}

describe('domainErrorStatus', () => {
  it.each([
    ['validation', 400],
    ['unauthorized', 401],
    ['forbidden', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['rate_limited', 429],
    ['timeout', 504],
    ['unavailable', 503],
  ] as const)('maps %s to %d', (code, status) => {
    expect(domainErrorStatus(errorOf(code))).toBe(status);
  });
});

describe('domainErrorBody', () => {
  it('answers the wire code without a message field', () => {
    expect(domainErrorBody(errorOf('unavailable'))).toEqual({ code: 'UNAVAILABLE' });
  });
});
