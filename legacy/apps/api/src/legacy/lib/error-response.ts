/**
 * Error response utilities for consistent API error handling.
 *
 * All error responses use `{ code, details? }` format.
 * Frontend maps `code` → user-facing message via `legacyFriendlyErrorMessage()`.
 */

import type { LegacyErrorResponse } from '@hushbox/shared';

/**
 * Creates a standardized error response object.
 *
 * @param code - Machine-readable error code
 * @param details - Optional additional context
 * @returns LegacyErrorResponse object
 */
export function createErrorResponse(
  code: string,
  details?: Record<string, unknown>
): LegacyErrorResponse {
  const response: LegacyErrorResponse = { code };
  if (details !== undefined) {
    response.details = details;
  }
  return response;
}

/**
 * Creates a JSON Response with standardized error format.
 *
 * @param code - Machine-readable error code
 * @param status - HTTP status code (default: 400)
 * @param details - Optional additional context
 * @returns Response object with JSON body
 */
export function errorJson(code: string, status = 400, details?: Record<string, unknown>): Response {
  const body = createErrorResponse(code, details);
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
