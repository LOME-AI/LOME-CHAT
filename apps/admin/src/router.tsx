import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { queryClient } from './providers/query-provider';
import type { QueryClient } from '@tanstack/react-query';

export interface RouterContext {
  queryClient: QueryClient;
}

export const router = createRouter({
  routeTree,
  context: { queryClient },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
