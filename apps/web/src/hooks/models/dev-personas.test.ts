import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { devPersonaKeys, useDevPersonas } from '@/hooks/models/dev-personas';
import type { DevPersonasResponse } from '@hushbox/shared';

vi.mock('@/lib/env.js', () => ({
  env: { isDev: true },
}));

vi.mock('@/lib/api-client.js', () => ({
  client: {
    dev: {
      personas: {
        $get: vi.fn(() => Promise.resolve(new Response())),
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/api-client.js';

const mockFetchJson = vi.mocked(fetchJson);

function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('devPersonaKeys', () => {
  describe('all', () => {
    it('returns base dev-personas key', () => {
      expect(devPersonaKeys.all).toEqual(['dev-personas']);
    });
  });

  describe('list', () => {
    it('returns list key array with default type', () => {
      expect(devPersonaKeys.list()).toEqual(['dev-personas', 'list', 'dev']);
    });

    it('returns list key array with custom type', () => {
      expect(devPersonaKeys.list('test')).toEqual(['dev-personas', 'list', 'test']);
    });
  });
});

describe('useDevPersonas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches dev personas by default', async () => {
    const mockResponse: DevPersonasResponse = {
      personas: [
        {
          id: 'user-1',
          username: 'alice_developer',
          email: 'alice@dev.hushbox.ai',
          emailVerified: true,
          stats: { conversationCount: 3, messageCount: 12, projectCount: 2 },
          credits: '$0.00',
        },
      ],
    };

    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useDevPersonas(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockResponse);
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('fetches test personas when type=test', async () => {
    const mockResponse: DevPersonasResponse = {
      personas: [
        {
          id: 'test-user-1',
          username: 'test_alice',
          email: 'test-alice@test.hushbox.ai',
          emailVerified: true,
          stats: { conversationCount: 0, messageCount: 0, projectCount: 0 },
          credits: '$0.00',
        },
      ],
    };

    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useDevPersonas('test'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockResponse);
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('retries with an exponential backoff delay when the fetch fails', async () => {
    vi.useFakeTimers();
    try {
      mockFetchJson.mockRejectedValue(new Error('network down'));

      // A wrapper that does not disable retry, so the hook's own `retry: 3`
      // and `retryDelay` (1s, 2s, 4s — capped at 5s) govern the observer.
      const queryClient = new QueryClient();
      const wrapper = function Wrapper({
        children,
      }: {
        children: React.ReactNode;
      }): React.JSX.Element {
        return React.createElement(QueryClientProvider, { client: queryClient }, children);
      };

      const { result } = renderHook(() => useDevPersonas(), { wrapper });

      // Advance past the full backoff schedule (1000 + 2000 + 4000 ms) with a
      // margin; each scheduled delay is produced by the `retryDelay` arrow.
      await vi.advanceTimersByTimeAsync(8000);

      expect(result.current.isError).toBe(true);
      // Initial attempt plus three retries.
      expect(mockFetchJson).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns empty array when no personas', async () => {
    const mockResponse: DevPersonasResponse = { personas: [] };

    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useDevPersonas(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.personas).toEqual([]);
  });
});
