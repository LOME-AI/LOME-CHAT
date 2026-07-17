import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@/lib/api-client';

/** TanStack's default retry count, kept for transient (5xx/transport) failures. */
const MAX_RETRIES = 3;

/**
 * A 4xx is a definitive answer (miss, validation, rate limit) — retrying it
 * repeats the identical request; only transient failures earn retries.
 */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

export const queryClient = new QueryClient({
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
