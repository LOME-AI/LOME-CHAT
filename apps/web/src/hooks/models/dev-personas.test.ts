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
