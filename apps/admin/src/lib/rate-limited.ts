import { ApiError } from './api-client.js';

/** Server default window when a 429 body carries no usable hint. */
const DEFAULT_RETRY_AFTER_SECONDS = 30;

/**
 * Seconds to wait before retrying a rate-limited admin read, or null when
 * the error is not a 429. The admin read routes answer 429 with
 * `{ code: 'RATE_LIMITED', details: { retryAfterSeconds } }` (no Retry-After
 * header), so the hint rides the JSON body `ApiError` captured.
 */
function serverHint(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const details = (body as Record<string, unknown>)['details'];
  if (typeof details !== 'object' || details === null) {
    return null;
  }
  const seconds = (details as Record<string, unknown>)['retryAfterSeconds'];
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function retryAfterSecondsOf(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.status !== 429) {
    return null;
  }
  return serverHint(error.body) ?? DEFAULT_RETRY_AFTER_SECONDS;
}
