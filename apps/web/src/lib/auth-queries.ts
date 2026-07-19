import { client, fetchJson } from '@/lib/api-client';
import type { MeResponse } from './auth-client.js';

export const authKeys = {
  all: ['auth'] as const,
  me: (): readonly ['auth', 'me'] => [...authKeys.all, 'me'] as const,
};

/**
 * Canonical query for the current user (`GET /api/auth/me`).
 *
 * Consumed imperatively via `queryClient.fetchQuery` during auth bootstrap
 * (`restoreSession`, `finalizeLoginWithKey`) so the request inherits the
 * app-wide retry policy (`query-provider` defaults) instead of being a one-off
 * `fetchJson` that silently skipped retries — the gap that let a transient
 * `/me` blip on reload bounce an authenticated user to the login screen.
 */
export function meQueryOptions(): {
  queryKey: readonly ['auth', 'me'];
  queryFn: () => Promise<MeResponse>;
} {
  return {
    queryKey: authKeys.me(),
    queryFn: () => fetchJson<MeResponse>(client.auth.me.$get()),
  };
}
