import { ERROR_CODES } from '@hushbox/shared';
import { describe, expect, it } from 'vitest';
import { isDomainError } from '../errors/index.js';
import { bodyMismatchError, isIdempotencyConflict, requestInProgressError } from './errors.js';

describe('idempotency conflict errors', () => {
  it('builds a body-mismatch conflict carrying its wire code', () => {
    const error = bodyMismatchError();
    expect(error.code).toBe('conflict');
    expect(error.wireCode).toBe(ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH);
    expect(isDomainError(error)).toBe(true);
  });

  it('builds an in-progress conflict carrying its wire code', () => {
    const error = requestInProgressError();
    expect(error.code).toBe('conflict');
    expect(error.wireCode).toBe(ERROR_CODES.REQUEST_IN_PROGRESS);
    expect(isDomainError(error)).toBe(true);
  });

  it('recognizes idempotency conflicts among domain errors', () => {
    expect(isIdempotencyConflict(bodyMismatchError())).toBe(true);
    expect(isIdempotencyConflict(requestInProgressError())).toBe(true);
    expect(isIdempotencyConflict({ code: 'conflict', message: 'other' })).toBe(false);
    expect(isIdempotencyConflict({ code: 'not_found', message: 'x' })).toBe(false);
  });
});
