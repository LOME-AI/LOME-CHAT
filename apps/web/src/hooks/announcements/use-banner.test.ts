import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';

const bannerGetMock = vi.fn(() => Promise.resolve(new Response()));
const dismissalGetMock = vi.fn((_args: unknown) => Promise.resolve(new Response()));
const dismissalPutMock = vi.fn((_args: unknown) => Promise.resolve(new Response()));

vi.mock('@/lib/api-client', () => ({
  client: {
    announcements: {
      banner: {
        $get: () => bannerGetMock(),
        dismissal: {
          $get: (args: unknown) => dismissalGetMock(args),
          $put: (args: unknown) => dismissalPutMock(args),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/api-client';
import {
  useBannerQuery,
  fetchServerDismissal,
  saveServerDismissal,
} from '@/hooks/announcements/use-banner';

const mockFetchJson = vi.mocked(fetchJson);

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactElement {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useBannerQuery', () => {
  it('fetches and returns the validated banner payload', async () => {
    mockFetchJson.mockResolvedValueOnce({
      hash: 'abc',
      variant: 'info',
      messages: [{ text: 'hi' }],
    });
    const { result } = renderHook(() => useBannerQuery(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toEqual({
      hash: 'abc',
      variant: 'info',
      messages: [{ text: 'hi' }],
    });
  });

  it('fails closed (error state) when the payload shape drifts', async () => {
    mockFetchJson.mockResolvedValueOnce({ not: 'a banner' });
    const { result } = renderHook(() => useBannerQuery(), { wrapper: createWrapper() });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('fetchServerDismissal', () => {
  it('queries by hash and reports the dismissed flag', async () => {
    mockFetchJson.mockResolvedValueOnce({ dismissed: true });
    await expect(fetchServerDismissal('hash-1')).resolves.toBe(true);
    expect(dismissalGetMock).toHaveBeenCalledWith({ query: { hash: 'hash-1' } });
  });

  it('returns false when the server reports not dismissed', async () => {
    mockFetchJson.mockResolvedValueOnce({ dismissed: false });
    await expect(fetchServerDismissal('hash-1')).resolves.toBe(false);
  });

  it('returns false when the request throws (e.g. 401)', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('unauthorized'));
    await expect(fetchServerDismissal('hash-1')).resolves.toBe(false);
  });

  it('returns false when the response shape is unexpected', async () => {
    mockFetchJson.mockResolvedValueOnce({ garbage: true });
    await expect(fetchServerDismissal('hash-1')).resolves.toBe(false);
  });
});

describe('saveServerDismissal', () => {
  it('PUTs the hash (fire-and-forget)', async () => {
    mockFetchJson.mockResolvedValueOnce();
    saveServerDismissal('hash-1');
    await tick();
    expect(dismissalPutMock).toHaveBeenCalledWith({ json: { hash: 'hash-1' } });
  });

  it('does not throw when the PUT rejects', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('offline'));
    expect(() => {
      saveServerDismissal('hash-1');
    }).not.toThrow();
    await tick();
  });
});
