import * as React from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

type RenderWithProvidersResult = ReturnType<typeof render> & { queryClient: QueryClient };

export function renderWithProviders(ui: React.ReactElement): RenderWithProvidersResult {
  const queryClient = createTestQueryClient();
  function AllProviders({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return Object.assign(render(ui, { wrapper: AllProviders }), { queryClient });
}

interface RouteWithComponent {
  options?: { component?: React.ComponentType };
  component?: React.ComponentType;
}

/**
 * Render a route's component obtained from the `Route` itself, through the
 * provider stack (same pattern as apps/web/src/test-utils/render.tsx).
 */
export function renderRoute(route: RouteWithComponent): RenderWithProvidersResult {
  const Component = route.options?.component ?? route.component;
  if (!Component) {
    throw new Error('renderRoute: the provided Route has no component');
  }
  return renderWithProviders(<Component />);
}
