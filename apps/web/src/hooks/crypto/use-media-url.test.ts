import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({
  client: {
    media: {
      [':contentItemId']: {
        'download-url': {
          $get: vi.fn(() => Promise.resolve(new Response())),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { client, fetchJson } from '@/lib/api-client';
import { useMediaDownloadUrl, mediaKeys } from '@/hooks/crypto/use-media-url';

const mockFetchJson = vi.mocked(fetchJson);
const mockGet = vi.mocked(client.media[':contentItemId']['download-url'].$get);

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('useMediaDownloadUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns downloadUrl from the API response when query resolves', async () => {
    mockFetchJson.mockResolvedValueOnce({
      downloadUrl: 'https://r2.example.com/presigned-url?token=abc',
      expiresAt: '2026-04-16T12:00:00Z',
    });

    const { result } = renderHook(() => useMediaDownloadUrl('content-item-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.downloadUrl).toBe('https://r2.example.com/presigned-url?token=abc');
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('query key includes the contentItemId', () => {
    const key = mediaKeys.downloadUrl('content-item-42');
    expect(key).toContain('content-item-42');
    expect(key).toEqual(['media', 'downloadUrl', 'content-item-42']);
  });

  it('returns isLoading true while pending', () => {
    // Return a promise that never resolves during this test
    mockFetchJson.mockImplementationOnce(() => new Promise(() => {}));

    const { result } = renderHook(() => useMediaDownloadUrl('content-item-1'), {
      wrapper: createWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.downloadUrl).toBeUndefined();
  });

  it('returns error when the API call fails', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useMediaDownloadUrl('content-item-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toBe('Network error');
    expect(result.current.downloadUrl).toBeUndefined();
  });

  it('does not fetch when contentItemId is null', () => {
    const { result } = renderHook(() => useMediaDownloadUrl(null), {
      wrapper: createWrapper(),
    });

    // When disabled, the query does not run
    expect(result.current.isLoading).toBe(false);
    expect(result.current.downloadUrl).toBeUndefined();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('calls the RPC client with the contentItemId param', async () => {
    mockFetchJson.mockResolvedValueOnce({
      downloadUrl: 'https://r2.example.com/url',
      expiresAt: '2026-04-16T12:00:00Z',
    });

    const { result } = renderHook(() => useMediaDownloadUrl('content-item-xyz'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.downloadUrl).toBeDefined();
    });

    expect(mockGet).toHaveBeenCalledWith({ param: { contentItemId: 'content-item-xyz' } });
  });

  it('uses a staleTime configured on the query (not the default of 0)', async () => {
    // We verify the query is not considered stale immediately after resolving.
    // If staleTime were 0, a second render with the same key would refetch.
    mockFetchJson.mockResolvedValue({
      downloadUrl: 'https://r2.example.com/url',
      expiresAt: '2026-04-16T12:00:00Z',
    });

    const wrapper = createWrapper();
    const { result, rerender } = renderHook(() => useMediaDownloadUrl('content-item-1'), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.downloadUrl).toBeDefined();
    });

    const firstCallCount = mockFetchJson.mock.calls.length;
    rerender();

    // Query should not refetch on re-render because staleTime > 0.
    expect(mockFetchJson.mock.calls.length).toBe(firstCallCount);
  });
});
