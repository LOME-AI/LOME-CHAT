import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

// Break the transitive env-parse chain: use-link-name → use-conversation-links
// → auth.ts → query-provider → api.ts (top-level `frontendEnvSchema.parse`).
vi.mock('@/lib/auth.js', () => ({
  useAuthStore: vi.fn((selector: (s: { user: { id: string } | null }) => unknown) =>
    selector({ user: { id: 'user-1' } })
  ),
}));

vi.mock('@/lib/api-client.js', () => ({
  client: {
    conversations: {
      ':conversationId': {
        'my-name': { $patch: vi.fn() },
        links: {
          ':linkId': {
            name: { $patch: vi.fn() },
          },
        },
      },
    },
  },
  fetchJson: vi.fn(() => Promise.resolve({ success: true })),
}));

import { client, fetchJson } from '@/lib/api-client.js';
import { useGuestLinkName, useAdminLinkName } from '@/hooks/realtime/use-link-name.js';
import { linkKeys } from '@/hooks/realtime/use-conversation-links.js';

const mockedClient = vi.mocked(client);
const mockedFetchJson = vi.mocked(fetchJson);

let testQueryClient: QueryClient;

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
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
    mockedFetchJson.mockResolvedValue({ success: true });
  });

  it('patches my-name with an Idempotency-Key', async () => {
    const { result } = renderHook(() => useGuestLinkName(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'conv-1', displayName: 'Bob' });
    });

    expect(mockedClient.conversations[':conversationId']['my-name'].$patch).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1' },
        json: { displayName: 'Bob' },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });
});

describe('useAdminLinkName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetchJson.mockResolvedValue({ success: true });
  });

  it('patches the link name with an Idempotency-Key', async () => {
    const { result } = renderHook(() => useAdminLinkName(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.mutateAsync({
        conversationId: 'conv-1',
        linkId: 'link-1',
        displayName: 'Guest label',
      });
    });

    expect(
      mockedClient.conversations[':conversationId'].links[':linkId'].name.$patch
    ).toHaveBeenCalledWith(
      {
        param: { conversationId: 'conv-1', linkId: 'link-1' },
        json: { displayName: 'Guest label' },
      },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates the link list on success', async () => {
    const { result } = renderHook(() => useAdminLinkName(), { wrapper: createWrapper() });
    const invalidateSpy = vi.spyOn(testQueryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.mutateAsync({
        conversationId: 'conv-1',
        linkId: 'link-1',
        displayName: 'x',
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: linkKeys.list('conv-1') });
  });
});
