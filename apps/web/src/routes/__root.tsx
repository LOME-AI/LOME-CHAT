import { Outlet, createRootRoute } from '@tanstack/react-router';
import { QueryProvider } from '@/providers/query-provider';

export const Route = createRootRoute({
  component: () => (
    <QueryProvider>
      <Outlet />
    </QueryProvider>
  ),
});
