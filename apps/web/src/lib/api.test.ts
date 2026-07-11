import { describe, it, expect, vi } from 'vitest';

const { parseMock } = vi.hoisted(() => ({
  parseMock: vi.fn((_env: unknown) => ({ VITE_API_URL: 'http://localhost:8787' })),
}));

vi.mock('@hushbox/shared', () => ({
  frontendEnvSchema: {
    parse: parseMock,
  },
}));

import { ApiError, getApiUrl, getErrorBody } from './api';

describe('getApiUrl', () => {
  it('returns the API URL from environment', () => {
    expect(getApiUrl()).toBe('http://localhost:8787');
  });
});

describe('frontend env parsing', () => {
  it('forwards VITE_PLATFORM and VITE_APP_VERSION from import.meta.env to the schema', () => {
    const arg = parseMock.mock.calls[0]?.[0];
    expect(arg).toHaveProperty('VITE_PLATFORM');
    expect(arg).toHaveProperty('VITE_APP_VERSION');
  });
});

describe('ApiError', () => {
  it('creates an error with message, status, and data', () => {
    const error = new ApiError('Not found', 404, { detail: 'missing' });
    expect(error.message).toBe('Not found');
    expect(error.status).toBe(404);
    expect(error.data).toEqual({ detail: 'missing' });
    expect(error.name).toBe('ApiError');
  });

  it('extends Error', () => {
    const error = new ApiError('fail', 500);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('getErrorBody', () => {
  it('extracts code and details from an ApiError with a response body', () => {
    const error = new ApiError('DELETE_ACCOUNT_LOCKED', 403, {
      code: 'DELETE_ACCOUNT_LOCKED',
      details: { retryAfterSeconds: 600 },
    });
    expect(getErrorBody(error)).toEqual({
      code: 'DELETE_ACCOUNT_LOCKED',
      details: { retryAfterSeconds: 600 },
    });
  });

  it('falls back to error.message when data lacks a code field', () => {
    const error = new ApiError('INTERNAL', 500);
    expect(getErrorBody(error)).toEqual({ code: 'INTERNAL' });
  });

  it('falls back to error.message when data is not a record', () => {
    const error = new ApiError('INVALID_JSON', 400, 'plain string body');
    expect(getErrorBody(error)).toEqual({ code: 'INVALID_JSON' });
  });

  it('returns undefined for non-ApiError values', () => {
    expect(getErrorBody(new Error('regular'))).toBeUndefined();
    expect(getErrorBody('string')).toBeUndefined();
    expect(getErrorBody(null)).toBeUndefined();
    expect(getErrorBody({ code: 'fake' })).toBeUndefined();
  });

  it('drops a non-record details field', () => {
    const error = new ApiError('VALIDATION', 422, {
      code: 'VALIDATION',
      details: 'not an object',
    });
    expect(getErrorBody(error)).toEqual({ code: 'VALIDATION' });
  });
});
