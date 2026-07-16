import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/lib/api-client.js', () => ({
  client: {
    account: {
      users: {
        search: { $get: vi.fn() },
      },
    },
  },
  fetchJson: vi.fn(),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQuery: vi.fn(actual.useQuery),
  };
});

import { useQuery } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import { useUserSearch } from '@/hooks/realtime/use-user-search.js';

const mockedUseQuery = vi.mocked(useQuery);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client);

describe('useUserSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables the query when query string is empty', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch(''));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      })
    );
  });

  it('disables the query when query string is a single character', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch('a'));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      })
    );
  });

  it('enables the query when it has 2+ characters and a conversation scope', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch('ab', { excludeConversationId: 'conv-1' }));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
      })
    );
  });

  // The rebuilt `GET /account/users/search` requires `conversationId`; the
  // hook fails closed (disabled) when the caller supplies none.
  it('disables the query when no conversation scope is provided', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch('ab'));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      })
    );
  });

  it('includes query in queryKey', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch('alice'));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['user-search', 'alice', undefined],
      })
    );
  });

  it('includes excludeConversationId in queryKey when provided', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch('alice', { excludeConversationId: 'conv-1' }));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['user-search', 'alice', 'conv-1'],
      })
    );
  });

  it('calls the correct client path in queryFn', async () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch('alice', { excludeConversationId: 'conv-1' }));

    const queryFunction = mockedUseQuery.mock.calls[0]![0].queryFn as () => Promise<unknown>;
    await queryFunction();

    expect(mockedClient.account.users.search.$get).toHaveBeenCalledWith({
      query: { q: 'alice', conversationId: 'conv-1' },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('falls back to an empty conversationId in queryFn when none is provided', async () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch('alice'));

    const queryFunction = mockedUseQuery.mock.calls[0]![0].queryFn as () => Promise<unknown>;
    await queryFunction();

    expect(mockedClient.account.users.search.$get).toHaveBeenCalledWith({
      query: { q: 'alice', conversationId: '' },
    });
  });

  it('normalizes query with spaces to underscores in queryKey', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch('John Smith', { excludeConversationId: 'conv-1' }));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['user-search', 'john_smith', 'conv-1'],
        enabled: true,
      })
    );
  });

  it('normalizes uppercase query to lowercase in queryKey', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch('Alice'));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['user-search', 'alice', undefined],
      })
    );
  });

  it('sends normalized query in queryFn', async () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useUserSearch('John Smith', { excludeConversationId: 'conv-1' }));

    const queryFunction = mockedUseQuery.mock.calls[0]![0].queryFn as () => Promise<unknown>;
    await queryFunction();

    expect(mockedClient.account.users.search.$get).toHaveBeenCalledWith({
      query: { q: 'john_smith', conversationId: 'conv-1' },
    });
  });
});
