import * as React from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { ROUTES } from '@hushbox/shared';
import { env } from '@/lib/env';
import { ApiError } from '@/lib/api';
import { installBlobUrlCacheGc } from '@/lib/blob-url-cache-gc';
import { shouldRetry, shouldRetryMutation, computeRetryDelay } from '@/lib/retry';

/**
 * Injected by the auth layer at startup (see `lib/auth.ts`). Clears the session
 * and returns true iff a live session existed — false when there is none, so an
 * expected OPAQUE login-challenge 401 (which fires before any session exists)
 * never triggers a clear or redirect. Kept as an injection point rather than a
 * direct import of `clearStoredAuth`: `lib/auth-client` imports `queryClient`
 * from this module, so a back-import would form an `import/no-cycle` violation.
 */
let clearRevokedSession: (() => boolean) | null = null;

export function registerSessionRevocationClearer(clearer: () => boolean): void {
  clearRevokedSession = clearer;
}

// One-shot latch: a definitive mid-session 401 clears auth and hard-navigates to
// login exactly once. The latch collapses a burst of parallel 401s into a single
// redirect and prevents a still-failing bootstrap query from looping it.
let sessionRevocationHandled = false;

// Test-only: restore this module's revocation state (latch + injected clearer)
// to its pristine, pre-startup shape so cases run independently.
export function resetSessionRevocationGuard(): void {
  sessionRevocationHandled = false;
  clearRevokedSession = null;
}

/**
 * Global cache-level error hook. Only a DEFINITIVE mid-session 401 — an
 * `ApiError` with status 401 while a live session exists and we are not already
 * on the login route — clears auth and redirects. Every other failure (non-401,
 * expected auth-challenge 401 with no session, transport error) is left for the
 * originating hook to surface as before.
 */
export function handleSessionRevocation(error: unknown): void {
  if (sessionRevocationHandled) return;
  if (!(error instanceof ApiError) || error.status !== 401) return;
  // Already on login (or mid-redirect) ⇒ nothing to clear, and redirecting again
  // would loop.
  if (globalThis.location.pathname === ROUTES.LOGIN) return;
  // No clearer wired yet (pre-startup) ⇒ nothing to act on.
  if (!clearRevokedSession) return;
  // Clearer reports false when no live session exists — an expected OPAQUE
  // login-challenge 401, never a mid-session revocation. It clears nothing then.
  if (!clearRevokedSession()) return;
  sessionRevocationHandled = true;
  globalThis.location.assign(ROUTES.LOGIN);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleSessionRevocation }),
  mutationCache: new MutationCache({ onError: handleSessionRevocation }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 30, // 30 minutes
      retry: shouldRetry,
      retryDelay: computeRetryDelay,
      refetchOnWindowFocus: false,
    },
    // Mutations retry network/no-response failures only (see lib/retry.ts):
    // safe for any mutation, idempotent or not, because the request never got
    // a server response. 5xx is deliberately excluded — the write may have
    // applied, and not every mutation carries an idempotency key.
    mutations: {
      retry: shouldRetryMutation,
      retryDelay: computeRetryDelay,
    },
  },
});

interface QueryProviderProps {
  children: React.ReactNode;
}

export function QueryProvider({ children }: Readonly<QueryProviderProps>): React.JSX.Element {
  // The blob-URL cache (`['media', 'blob', …]`) owns object URLs that survive
  // component unmount via React Query. Without this subscriber, evicted cache
  // entries would leak: the underlying Blob bytes stay reachable until the
  // document unloads. See `useDecryptBlob` for the read side. Lives in an
  // effect so HMR re-installs cleanly without leaking duplicate subscribers.
  React.useEffect(() => installBlobUrlCacheGc(queryClient), []);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {env.isLocalDev && !navigator.webdriver && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      )}
    </QueryClientProvider>
  );
}
