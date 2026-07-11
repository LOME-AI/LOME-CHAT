import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

import { useGuestLinkName, useAdminLinkName } from '@/hooks/realtime/use-link-name.js';
import { linkKeys } from '@/hooks/realtime/use-conversation-links.js';

// UNPORTED: the rebuilt backend has no guest/admin link-rename mutation (only
// `GET /conversations/:id/my-name` exists). Both hooks reject like a 404
// through `unportedEndpoint`; these tests pin that contract and the cache
// invalidation that must survive the eventual repoint.
function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

let testQueryClient: QueryClient;

function createWrapperWithClient(): ({ children }: { children: ReactNode }) => ReactNode {
  testQueryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: testQueryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('useGuestLinkName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with a 404 ApiError naming the unported endpoint', async () => {
    const { result } = renderHook(() => useGuestLinkName(), { wrapper: createWrapper() });

    await expect(
      result.current.mutateAsync({ conversationId: 'conv-1', displayName: 'Bob' })
    ).rejects.toMatchObject({ message: 'NOT_FOUND', status: 404 });
  });
});

describe('useAdminLinkName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with a 404 ApiError naming the unported endpoint', async () => {
    const { result } = renderHook(() => useAdminLinkName(), { wrapper: createWrapper() });

    await expect(
      result.current.mutateAsync({
        conversationId: 'conv-1',
        linkId: 'link-1',
        displayName: 'Guest label',
      })
    ).rejects.toMatchObject({ message: 'NOT_FOUND', status: 404 });
  });

  it('does not invalidate the link list when the mutation fails', async () => {
    const { result } = renderHook(() => useAdminLinkName(), {
      wrapper: createWrapperWithClient(),
    });
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    await act(async () => {
      await result.current
        .mutateAsync({ conversationId: 'conv-1', linkId: 'link-1', displayName: 'x' })
        .catch(() => undefined);
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: linkKeys.list('conv-1'),
    });
  });
});
