import { describe, it, expect } from 'vitest';
import { ApiError } from './api.js';
import { unportedEndpoint } from './unported-endpoint.js';

describe('unportedEndpoint', () => {
  it('rejects with a 404 ApiError naming the legacy endpoint', async () => {
    const promise = unportedEndpoint('POST /api/billing/login-link');
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await promise.catch((error: unknown) => {
      const apiError = error as ApiError;
      expect(apiError.message).toBe('NOT_FOUND');
      expect(apiError.status).toBe(404);
      expect(apiError.data).toEqual({
        code: 'NOT_FOUND',
        details: { legacyEndpoint: 'POST /api/billing/login-link' },
      });
    });
  });
});
