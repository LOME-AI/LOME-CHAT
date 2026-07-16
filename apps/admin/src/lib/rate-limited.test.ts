import { describe, it, expect } from 'vitest';
import { ApiError } from './api-client.js';
import { retryAfterSecondsOf } from './rate-limited.js';

describe('retryAfterSecondsOf', () => {
  it('returns the server retryAfterSeconds for a 429 ApiError', () => {
    const error = new ApiError('RATE_LIMITED', 429, {
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 42 },
    });
    expect(retryAfterSecondsOf(error)).toBe(42);
  });

  it('falls back to a default wait for a 429 without details', () => {
    expect(retryAfterSecondsOf(new ApiError('RATE_LIMITED', 429))).toBe(30);
  });

  it('returns null for a non-429 ApiError', () => {
    expect(retryAfterSecondsOf(new ApiError('UNAVAILABLE', 503))).toBeNull();
  });

  it('returns null for a non-ApiError value', () => {
    let missing: unknown;
    expect(retryAfterSecondsOf(new Error('boom'))).toBeNull();
    expect(retryAfterSecondsOf(missing)).toBeNull();
  });

  it('falls back when the 429 body has no details object', () => {
    expect(retryAfterSecondsOf(new ApiError('RATE_LIMITED', 429, { code: 'RATE_LIMITED' }))).toBe(
      30
    );
    expect(retryAfterSecondsOf(new ApiError('RATE_LIMITED', 429, 'nope'))).toBe(30);
  });

  it('ignores a non-positive retryAfterSeconds', () => {
    const error = new ApiError('RATE_LIMITED', 429, {
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 0 },
    });
    expect(retryAfterSecondsOf(error)).toBe(30);
  });

  it('ignores a malformed retryAfterSeconds', () => {
    const error = new ApiError('RATE_LIMITED', 429, {
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: 'soon' },
    });
    expect(retryAfterSecondsOf(error)).toBe(30);
  });
});
