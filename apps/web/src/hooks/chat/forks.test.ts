import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';
import {
  useCreateFork,
  useDeleteFork,
  useRenameFork,
  useForks,
  forkKeys,
} from '@/hooks/chat/forks';

// Mock api module to avoid env parse
vi.mock('@/lib/api', () => ({}));

// Mock chat module to avoid transitive env dependency
vi.mock('@/hooks/chat/chat', () => ({
  chatKeys: {
    all: ['chat'] as const,
    conversations: () => ['chat', 'conversations'] as const,
    conversation: (id: string) => ['chat', 'conversations', id] as const,
    messages: (conversationId: string) =>
      ['chat', 'conversations', conversationId, 'messages'] as const,
  },
}));

vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      [':conversationId']: {
        $get: vi.fn(() => Promise.resolve(new Response())),
        forks: {
          $post: vi.fn(() => Promise.resolve(new Response())),
          [':forkId']: {
            $delete: vi.fn(() => Promise.resolve(new Response())),
            $patch: vi.fn(() => Promise.resolve(new Response())),
          },
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson, client } from '@/lib/api-client';

const mockFetchJson = vi.mocked(fetchJson);

const IDEMPOTENT_HEADER = { headers: { 'Idempotency-Key': expect.any(String) } };

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactElement {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('forkKeys', () => {
  it('generates conversation-scoped fork key', () => {
    expect(forkKeys.forConversation('conv-1')).toEqual(['forks', 'conv-1']);
  });
});

describe('useCreateFork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the create fork API and returns the result', async () => {
    const forkResult = {
      forks: [
        {
          id: 'fork-main',
          conversationId: 'conv-1',
          name: 'Main',
          tipMessageId: 'msg-5',
          createdAt: '2026-03-03',
        },
        {
          id: 'fork-1',
          conversationId: 'conv-1',
          name: 'Fork 1',
          tipMessageId: 'msg-3',
          createdAt: '2026-03-03',
        },
      ],
    };
    mockFetchJson.mockResolvedValueOnce(forkResult);

    const { result } = renderHook(() => useCreateFork(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({
        id: 'fork-1',
        conversationId: 'conv-1',
        fromMessageId: 'msg-3',
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(forkResult);
    expect(vi.mocked(client.conversations[':conversationId'].forks.$post)).toHaveBeenCalledWith(
      expect.anything(),
      IDEMPOTENT_HEADER
    );
  });
});

describe('useDeleteFork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the delete fork API', async () => {
    mockFetchJson.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => useDeleteFork(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({ conversationId: 'conv-1', forkId: 'fork-1' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(
      vi.mocked(client.conversations[':conversationId'].forks[':forkId'].$delete)
    ).toHaveBeenCalledWith(expect.anything(), IDEMPOTENT_HEADER);
  });
});

describe('useRenameFork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the rename fork API', async () => {
    const renameResult = {
      fork: {
        id: 'fork-1',
        conversationId: 'conv-1',
        name: 'My Branch',
        tipMessageId: 'msg-3',
        createdAt: '2026-03-03',
      },
    };
    mockFetchJson.mockResolvedValueOnce(renameResult);

    const { result } = renderHook(() => useRenameFork(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({ conversationId: 'conv-1', forkId: 'fork-1', name: 'My Branch' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(renameResult);
    expect(
      vi.mocked(client.conversations[':conversationId'].forks[':forkId'].$patch)
    ).toHaveBeenCalledWith(expect.anything(), IDEMPOTENT_HEADER);
  });

  it('updates fork name in cache in-place without reordering', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const conversationCacheKey = ['chat', 'conversations', 'conv-1'];
    const initialForks = [
      {
        id: 'fork-main',
        conversationId: 'conv-1',
        name: 'Main',
        tipMessageId: 'msg-5',
        createdAt: '2026-03-01',
      },
      {
        id: 'fork-1',
        conversationId: 'conv-1',
        name: 'Fork 1',
        tipMessageId: 'msg-3',
        createdAt: '2026-03-02',
      },
      {
        id: 'fork-2',
        conversationId: 'conv-1',
        name: 'Fork 2',
        tipMessageId: 'msg-4',
        createdAt: '2026-03-03',
      },
    ];
    queryClient.setQueryData(conversationCacheKey, {
      conversation: {},
      messages: [],
      forks: initialForks,
      accepted: true,
      invitedByUsername: null,
      callerId: 'user-1',
      privilege: 'owner',
    });

    mockFetchJson.mockResolvedValueOnce({ renamed: true });

    function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactElement {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }
    Wrapper.displayName = 'TestWrapper';

    const { result } = renderHook(() => useRenameFork(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({ conversationId: 'conv-1', forkId: 'fork-1', name: 'Renamed Fork' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const cached = queryClient.getQueryData<{ forks: { id: string; name: string }[] }>(
      conversationCacheKey
    )!;
    expect(cached.forks).toHaveLength(3);
    expect(cached.forks[0]!.id).toBe('fork-main');
    expect(cached.forks[1]!.id).toBe('fork-1');
    expect(cached.forks[1]!.name).toBe('Renamed Fork');
    expect(cached.forks[2]!.id).toBe('fork-2');
  });
});

describe('useForks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns forks from the conversation API response', async () => {
    const forks = [
      {
        id: 'fork-main',
        conversationId: 'conv-1',
        name: 'Main',
        tipMessageId: 'msg-5',
        createdAt: '2026-03-03',
      },
      {
        id: 'fork-1',
        conversationId: 'conv-1',
        name: 'Fork 1',
        tipMessageId: 'msg-3',
        createdAt: '2026-03-03',
      },
    ];
    mockFetchJson.mockResolvedValueOnce({
      conversation: {},
      messages: [],
      forks,
      accepted: true,
      invitedByUsername: null,
    });

    const { result } = renderHook(() => useForks('conv-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data).toEqual(forks);
  });

  it('returns empty array when no forks in response', async () => {
    mockFetchJson.mockResolvedValueOnce({
      conversation: {},
      messages: [],
      forks: [],
      accepted: true,
      invitedByUsername: null,
    });

    const { result } = renderHook(() => useForks('conv-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data).toEqual([]);
  });

  it('is disabled when conversationId is empty', () => {
    const { result } = renderHook(() => useForks(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.isFetching).toBe(false);
  });
});
