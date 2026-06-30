import { describe, expect, it } from 'vitest';
import { ERROR_CODES, errorResponseSchema } from '@hushbox/shared';
import { createErrorResponse } from './error-response.js';

describe('createErrorResponse', () => {
  it('returns the bare {code} body when details are omitted', () => {
    expect(createErrorResponse(ERROR_CODES.NOT_FOUND)).toEqual({ code: 'NOT_FOUND' });
  });

  it('serializes without a details key when details are omitted', () => {
    // Byte-level wire contract: `{ code }` exactly — an absent details key,
    // never `details: undefined`, and never a message field.
    expect(JSON.stringify(createErrorResponse(ERROR_CODES.INTERNAL))).toBe('{"code":"INTERNAL"}');
  });

  it('includes details when provided', () => {
    expect(createErrorResponse(ERROR_CODES.VALIDATION, { field: 'email' })).toEqual({
      code: 'VALIDATION',
      details: { field: 'email' },
    });
  });

  it('produces a body that satisfies the shared wire schema', () => {
    const parsed = errorResponseSchema.safeParse(
      createErrorResponse(ERROR_CODES.CONFLICT, { reason: 'stale' })
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects codes outside the shared registry at compile time', () => {
    // @ts-expect-error -- the code parameter is the closed ErrorCode union, never a free string
    const body = createErrorResponse('SOMETHING_ELSE');
    expect(body).toBeDefined();
  });
});
