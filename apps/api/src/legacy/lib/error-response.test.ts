import { describe, it, expect } from 'vitest';
import {
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_VALIDATION,
} from '@hushbox/shared';
import { createErrorResponse, errorJson } from './error-response.js';

describe('createErrorResponse', () => {
  it('creates error response with just code', () => {
    const response = createErrorResponse(ERROR_CODE_UNAUTHORIZED);
    expect(response).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('creates error response with code and details', () => {
    const response = createErrorResponse(ERROR_CODE_VALIDATION, {
      field: 'email',
    });
    expect(response).toEqual({
      code: 'VALIDATION',
      details: { field: 'email' },
    });
  });

  it('omits details when undefined', () => {
    const response = createErrorResponse(ERROR_CODE_NOT_FOUND);
    expect(response).toEqual({ code: 'NOT_FOUND' });
    expect('details' in response).toBe(false);
  });
});

describe('errorJson', () => {
  it('creates JSON response with 400 status by default', () => {
    const response = errorJson(ERROR_CODE_VALIDATION);
    expect(response.status).toBe(400);
  });

  it('creates JSON response with specified status', () => {
    const response = errorJson(ERROR_CODE_NOT_FOUND, 404);
    expect(response.status).toBe(404);
  });

  it('returns correct JSON body with code only', async () => {
    const response = errorJson(ERROR_CODE_UNAUTHORIZED, 401);
    const body = await response.json();
    expect(body).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('includes details in body', async () => {
    const response = errorJson(ERROR_CODE_VALIDATION, 400, { field: 'name' });
    const body = await response.json();
    expect(body).toEqual({
      code: 'VALIDATION',
      details: { field: 'name' },
    });
  });
});
