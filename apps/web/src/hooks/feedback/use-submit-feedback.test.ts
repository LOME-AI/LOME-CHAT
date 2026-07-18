import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({
  client: {
    feedback: { $post: vi.fn() },
  },
  fetchJson: vi.fn(),
}));

import { useSubmitFeedback } from '@/hooks/feedback/use-submit-feedback';
import { client, fetchJson } from '@/lib/api-client';

const mockedClient = vi.mocked(client, true);
const mockedFetchJson = vi.mocked(fetchJson);

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

describe('useSubmitFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts the kind and body with a fresh Idempotency-Key header', async () => {
    vi.mocked(mockedClient.feedback.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<typeof mockedClient.feedback.$post>
    );
    mockedFetchJson.mockImplementation(() => Promise.resolve());

    const { result } = renderHook(() => useSubmitFeedback(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ kind: 'idea', body: 'ship dark mode' });

    expect(mockedClient.feedback.$post).toHaveBeenCalledWith(
      { json: { kind: 'idea', body: 'ship dark mode' } },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
  });

  it('mints a distinct Idempotency-Key per submit', async () => {
    vi.mocked(mockedClient.feedback.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<typeof mockedClient.feedback.$post>
    );
    mockedFetchJson.mockImplementation(() => Promise.resolve());

    const { result } = renderHook(() => useSubmitFeedback(), { wrapper: createWrapper() });

    await result.current.mutateAsync({ kind: 'bug', body: 'first' });
    await result.current.mutateAsync({ kind: 'bug', body: 'second' });

    const calls = vi.mocked(mockedClient.feedback.$post).mock.calls;
    const keyOf = (index: number): string =>
      (calls[index]?.[1] as { headers: { 'Idempotency-Key': string } }).headers['Idempotency-Key'];
    expect(keyOf(0)).not.toBe(keyOf(1));
  });

  it('propagates a submit failure to the caller', async () => {
    vi.mocked(mockedClient.feedback.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<typeof mockedClient.feedback.$post>
    );
    mockedFetchJson.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useSubmitFeedback(), { wrapper: createWrapper() });

    await expect(result.current.mutateAsync({ kind: 'praise', body: 'nice' })).rejects.toThrow(
      'boom'
    );
  });
});
