import type { ErrorCode, ErrorResponse } from '@hushbox/shared';

/**
 * The single constructor for API error bodies: `{ code, details? }`, typed
 * against the shared closed code registry — a message field on the wire is a
 * contract violation (clients map codes to copy via `friendlyErrorMessage`).
 * The details key is ABSENT when not provided, never `details: undefined`:
 * the serialized body must stay byte-identical to the bare `{ code }` shape.
 */
export function createErrorResponse(
  code: ErrorCode,
  details?: Record<string, unknown>
): ErrorResponse {
  return details === undefined ? { code } : { code, details };
}
