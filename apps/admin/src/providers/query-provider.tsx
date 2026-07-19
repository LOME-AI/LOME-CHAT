import * as React from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { ApiError, AccessExpiredError } from '@/lib/api-client';

/** TanStack's default retry count, kept for transient (5xx/transport) failures. */
const MAX_RETRIES = 3;

/** sessionStorage key holding the epoch-ms of the last re-auth reload. */
const REAUTH_RELOAD_AT_KEY = 'hushbox.admin.reauthReloadAt';

/**
 * Minimum gap between re-auth reloads. Survives the reload in sessionStorage so
 * an Access challenge that fails to clear the expired cookie cannot spin the
 * page into a reload loop; a genuine re-expiry after the window still re-auths.
 */
const REAUTH_RELOAD_MIN_INTERVAL_MS = 10_000;

/**
 * A 4xx is a definitive answer (miss, validation, rate limit) — retrying it
 * repeats the identical request; only transient failures earn retries. An
 * Access expiry is not transient either — the retry would refetch the login
 * page — so it short-circuits to the reload path instead.
 */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (error instanceof AccessExpiredError) {
    return false;
  }
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

/**
 * Force a full navigation so Cloudflare Access re-runs its challenge on the
 * document request. The sessionStorage timestamp is the single loop guard: it
 * collapses a burst of parallel panel expiries into one reload and, because it
 * outlives the reload, stops a still-expired cookie from looping.
 */
export function reloadForReauth(): void {
  const now = Date.now();
  const lastAt = Number(sessionStorage.getItem(REAUTH_RELOAD_AT_KEY));
  if (lastAt && now - lastAt < REAUTH_RELOAD_MIN_INTERVAL_MS) {
    return;
  }
  sessionStorage.setItem(REAUTH_RELOAD_AT_KEY, String(now));
  globalThis.location.reload();
}

/**
 * Cache-level error hook: only an Access expiry navigates; every other failure
 * stays an error the screen renders as before.
 */
export function reloadOnAccessExpiry(error: unknown): void {
  if (error instanceof AccessExpiredError) {
    reloadForReauth();
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reloadOnAccessExpiry }),
  mutationCache: new MutationCache({ onError: reloadOnAccessExpiry }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      // An ops tool over live operational data: operators refetch explicitly;
      // a focus-triggered refetch mid-investigation is churn, not freshness.
      refetchOnWindowFocus: false,
      retry: retryUnlessClientError,
    },
  },
});

interface QueryProviderProps {
  children: React.ReactNode;
}

export function QueryProvider({ children }: Readonly<QueryProviderProps>): React.JSX.Element {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
