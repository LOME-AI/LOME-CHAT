import { hc } from 'hono/client';
import { isDevAuthEnabled } from './env.js';
import { createDevAuthFetch } from './dev-auth.js';
import { getDevActor } from './dev-actor.js';
import type { AppType } from '@hushbox/api';

/**
 * Path mapping — the admin SPA always calls RELATIVE `/api/*` on its own
 * origin; the typed client's base is this prefix, so
 * `client.admin.dashboard.$get()` requests `/api/admin/dashboard`.
 *
 * - Local dev: the Vite proxy (vite.config.ts) forwards `/api/*` to the
 *   product Worker on HB_API_PORT and strips the `/api` prefix
 *   (stripApiPrefix in api-proxy.ts), because the Worker mounts every slice
 *   at the root (`/admin/...`, `/dev/...`) — there is no `/api` prefix on
 *   the Worker itself.
 * - Production: Cloudflare routes `admin.hushbox.ai/api/*` to the product
 *   Worker (apps/api/wrangler.toml). Cloudflare routes do NOT rewrite the
 *   path, so the Worker must strip the `/api` prefix for requests arriving
 *   on the admin hostname before route matching — the production
 *   counterpart of the dev proxy's rewrite.
 */
export const ADMIN_API_BASE = '/api';

// Bound so the wrapper can call it detached from globalThis without an
// Illegal-invocation throw. Exported for the rare call that must inspect the
// raw Response instead of riding `fetchJson`'s throw-on-failure unwrap (the
// op prefill probe); it carries the same dev-auth header injection as the
// typed client.
export const adminFetch = createDevAuthFetch({
  baseFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  enabled: isDevAuthEnabled(),
  getActor: getDevActor,
});

// Explicit annotation keeps this export portable (same TS2883 workaround as
// apps/web/src/lib/api-client.ts): `ReturnType<typeof hc<AppType>>` pins the
// client type through a nameable alias.
export const client: ReturnType<typeof hc<AppType>> = hc<AppType>(ADMIN_API_BASE, {
  init: { credentials: 'include' },
  fetch: adminFetch,
});

export class ApiError extends Error {
  constructor(
    code: string,
    public status: number,
    public body?: unknown
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/**
 * A dedicated, distinguishable failure for an expired Cloudflare Access cookie:
 * `/api/*` no longer reaches the Worker as JSON, so there is nothing to render
 * — the query layer must force a full navigation to re-run the Access
 * challenge, never surface this as a generic error. Kept separate from
 * `ApiError` precisely so `onError` can branch on it without matching a real
 * API failure.
 */
export class AccessExpiredError extends Error {
  constructor() {
    super('ACCESS_EXPIRED');
    this.name = 'AccessExpiredError';
  }
}

/**
 * The fingerprint of an expired Access cookie. Access answers a `/api/*` call
 * whose assertion has lapsed by redirecting the request to its login page —
 * `fetch` follows the 302 and lands on a 200 HTML document — or by rejecting
 * the assertion outright with 401; a cross-origin hop can also surface as an
 * opaque redirect. Because a genuine admin API response is always JSON, a 200
 * that is not JSON is the login page, never a real success. Error statuses
 * other than 401 carry real JSON `{ code }` bodies and stay `ApiError`s.
 */
export function isAccessExpirySignature(res: Response): boolean {
  if (res.type === 'opaqueredirect' || res.redirected) {
    return true;
  }
  if (res.status === 401) {
    return true;
  }
  if (res.status === 200) {
    const contentType = res.headers.get('content-type') ?? '';
    return !contentType.includes('application/json');
  }
  return false;
}

/**
 * Unwrap a Hono RPC client Response: parsed JSON on success (`undefined` for
 * 204), ApiError carrying the body's `{ code }` on failure.
 */
export async function fetchJson<T>(responsePromise: Promise<Response>): Promise<T> {
  const res = await responsePromise;
  if (isAccessExpirySignature(res)) {
    throw new AccessExpiredError();
  }
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const code =
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      typeof (body as Record<string, unknown>)['code'] === 'string'
        ? ((body as Record<string, unknown>)['code'] as string)
        : 'INTERNAL';
    throw new ApiError(code, res.status, body);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}
