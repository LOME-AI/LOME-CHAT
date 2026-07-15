import { hc } from 'hono/client';
import { z } from 'zod';
import { useAppVersionStore } from '@/stores/app-version.js';
import { getPlatform } from '@/capacitor/platform.js';
import { ApiError, getApiUrl } from './api.js';
import { parseRetryAfterMs } from './retry.js';
import { getLinkGuestAuth } from './link-guest-auth.js';
import type { AppType } from '@hushbox/api';

// Registry-backed: `envConfig` supplies VITE_APP_VERSION for every mode (validated
// there as `z.string().min(1)`), so a missing/empty value is a broken bootstrap
// that must fail fast (zod throws), never silently resolve to 'dev-local'.
const appVersion = z
  .string()
  .min(1)
  .parse(import.meta.env['VITE_APP_VERSION']);

const customFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('X-HushBox-Platform', getPlatform());
  headers.set('X-App-Version', appVersion);

  const linkKey = getLinkGuestAuth();
  if (linkKey) {
    headers.set('X-Link-Public-Key', linkKey);
    return fetch(input, { ...init, headers, credentials: 'omit' });
  }
  return fetch(input, { ...init, headers });
};

// Explicit annotation keeps this export portable: the inferred `hc<AppType>`
// type transitively names branded symbols (`Idempotent`, `LedgerEntryKind`)
// that TypeScript cannot re-emit by reference (TS2883). `ReturnType<typeof
// hc<AppType>>` pins the same client type through a nameable alias.
export const client: ReturnType<typeof hc<AppType>> = hc<AppType>(getApiUrl(), {
  init: { credentials: 'include' },
  fetch: customFetch,
});

/**
 * Pulls the optional `currentVersion` / `updateUrl` fields out of a 426
 * VERSION_MISMATCH response body. Returns `undefined` when the body is absent
 * or not an object (legacy/bodyless 426) so the caller falls back to flipping
 * only the boolean flag; missing individual fields become `null`.
 */
function extractVersionMismatch(
  body: unknown
): { currentVersion: string | null; updateUrl: string | null } | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const currentVersion =
    typeof record['currentVersion'] === 'string' ? record['currentVersion'] : null;
  const updateUrl = typeof record['updateUrl'] === 'string' ? record['updateUrl'] : null;
  return { currentVersion, updateUrl };
}

/**
 * Unwrap a Hono RPC client Response.
 * On success (res.ok), returns parsed JSON, or `undefined as T` for 204 No Content.
 * On failure, throws ApiError with the error message from the response body.
 */
export async function fetchJson<T>(responsePromise: Promise<Response>): Promise<T> {
  const res = await responsePromise;
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
    if (res.status === 426) {
      useAppVersionStore.getState().setUpgradeRequired(true, extractVersionMismatch(body));
    }
    const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'));
    throw new ApiError(code, res.status, body, retryAfterMs ?? undefined);
  }
  // 204 No Content has no body; treat as undefined. Callers that expect a
  // payload should use a 200/201 endpoint instead.
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}
