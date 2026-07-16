import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      // An ops tool over live operational data: operators refetch explicitly;
      // a focus-triggered refetch mid-investigation is churn, not freshness.
      refetchOnWindowFocus: false,
    },
  },
});

interface QueryProviderProps {
  children: React.ReactNode;
}

export function QueryProvider({ children }: Readonly<QueryProviderProps>): React.JSX.Element {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
