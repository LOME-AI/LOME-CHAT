import { ApiError } from './api.js';

/**
 * Isolation point for call-sites whose legacy endpoint has no route on the
 * rebuilt backend. Each caller names the legacy endpoint it used to hit so
 * the gap is greppable. Rejects with the same `ApiError` shape `fetchJson()`
 * produces for a 404 — which is exactly what the server would answer if the
 * old path were requested — so caller error handling behaves identically
 * without a wasted network round trip.
 *
 * Every entry here is a reported gap, not a permanent state: the call-site
 * moves back onto the typed client the moment the backend mounts the route.
 */
export function unportedEndpoint(legacyEndpoint: string): Promise<never> {
  return Promise.reject(
    new ApiError('NOT_FOUND', 404, { code: 'NOT_FOUND', details: { legacyEndpoint } })
  );
}
