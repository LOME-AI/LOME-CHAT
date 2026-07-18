import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({
  client: {
    newsletter: { me: { $get: vi.fn(), $put: vi.fn() } },
  },
  fetchJson: vi.fn(),
}));

import {
  useNewsletterSettings,
  useUpdateNewsletterSettings,
  newsletterKeys,
} from '@/hooks/newsletter/use-newsletter-settings';
import { client, fetchJson } from '@/lib/api-client';

const mockedClient = vi.mocked(client, true);
const mockedFetchJson = vi.mocked(fetchJson);

function createWrapper(): {
  wrapper: ({ children }: { children: ReactNode }) => ReactNode;
  queryClient: QueryClient;
} {
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
  return { wrapper: Wrapper, queryClient };
}

function stubResponse(): Promise<Response> {
  return Promise.resolve(new Response());
}

describe('useNewsletterSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the subscription state from GET /newsletter/me', async () => {
    vi.mocked(mockedClient.newsletter.me.$get).mockReturnValue(
      stubResponse() as unknown as ReturnType<typeof mockedClient.newsletter.me.$get>
    );
    mockedFetchJson.mockResolvedValue({ subscribed: true });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useNewsletterSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.data).toEqual({ subscribed: true });
    });
    expect(mockedClient.newsletter.me.$get).toHaveBeenCalledTimes(1);
  });

  it('surfaces a read failure as query error state', async () => {
    vi.mocked(mockedClient.newsletter.me.$get).mockReturnValue(
      stubResponse() as unknown as ReturnType<typeof mockedClient.newsletter.me.$get>
    );
    mockedFetchJson.mockRejectedValue(new Error('boom'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useNewsletterSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useUpdateNewsletterSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the body via PUT /newsletter/me without an Idempotency-Key header', async () => {
    vi.mocked(mockedClient.newsletter.me.$put).mockReturnValue(
      stubResponse() as unknown as ReturnType<typeof mockedClient.newsletter.me.$put>
    );
    mockedFetchJson.mockResolvedValue({ subscribed: true });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUpdateNewsletterSettings(), { wrapper });

    await result.current.mutateAsync({ subscribed: true });

    // Naturally idempotent route: the client call carries no headers argument at all.
    expect(mockedClient.newsletter.me.$put).toHaveBeenCalledTimes(1);
    expect(mockedClient.newsletter.me.$put).toHaveBeenCalledWith({ json: { subscribed: true } });
    expect(vi.mocked(mockedClient.newsletter.me.$put).mock.calls[0]).toHaveLength(1);
  });

  it('optimistically flips the cached subscription state before the server answers', async () => {
    vi.mocked(mockedClient.newsletter.me.$put).mockReturnValue(
      stubResponse() as unknown as ReturnType<typeof mockedClient.newsletter.me.$put>
    );
    let resolvePut: (value: unknown) => void = () => {};
    mockedFetchJson.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePut = resolve;
        })
    );

    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(newsletterKeys.settings, { subscribed: false });
    const { result } = renderHook(() => useUpdateNewsletterSettings(), { wrapper });

    const mutation = result.current.mutateAsync({ subscribed: true });

    await waitFor(() => {
      expect(queryClient.getQueryData(newsletterKeys.settings)).toEqual({ subscribed: true });
    });

    resolvePut({ subscribed: true });
    await mutation;
  });

  it('reconciles the cache to the server truth when a suppressed subscriber answers false', async () => {
    vi.mocked(mockedClient.newsletter.me.$put).mockReturnValue(
      stubResponse() as unknown as ReturnType<typeof mockedClient.newsletter.me.$put>
    );
    // Complaint-suppressed subscriber: optimistic true, server answers false.
    mockedFetchJson.mockResolvedValue({ subscribed: false });

    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(newsletterKeys.settings, { subscribed: false });
    const { result } = renderHook(() => useUpdateNewsletterSettings(), { wrapper });

    const data = await result.current.mutateAsync({ subscribed: true });

    expect(data).toEqual({ subscribed: false });
    expect(queryClient.getQueryData(newsletterKeys.settings)).toEqual({ subscribed: false });
    await waitFor(() => {
      expect(result.current.isError).toBe(false);
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it('leaves the cache untouched when the mutation fails before the optimistic write', async () => {
    vi.mocked(mockedClient.newsletter.me.$put).mockReturnValue(
      stubResponse() as unknown as ReturnType<typeof mockedClient.newsletter.me.$put>
    );
    mockedFetchJson.mockResolvedValue({ subscribed: true });

    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(newsletterKeys.settings, { subscribed: false });
    // A failure inside onMutate reaches onError with no context; the rollback
    // must not run (there is no optimistic write to undo).
    vi.spyOn(queryClient, 'cancelQueries').mockRejectedValue(new Error('cancel failed'));
    const { result } = renderHook(() => useUpdateNewsletterSettings(), { wrapper });

    await expect(result.current.mutateAsync({ subscribed: true })).rejects.toThrow('cancel failed');

    expect(queryClient.getQueryData(newsletterKeys.settings)).toEqual({ subscribed: false });
  });

  it('rolls the cache back to the previous state when the update fails', async () => {
    vi.mocked(mockedClient.newsletter.me.$put).mockReturnValue(
      stubResponse() as unknown as ReturnType<typeof mockedClient.newsletter.me.$put>
    );
    mockedFetchJson.mockRejectedValue(new Error('boom'));

    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(newsletterKeys.settings, { subscribed: false });
    const { result } = renderHook(() => useUpdateNewsletterSettings(), { wrapper });

    await expect(result.current.mutateAsync({ subscribed: true })).rejects.toThrow('boom');

    expect(queryClient.getQueryData(newsletterKeys.settings)).toEqual({ subscribed: false });
  });
});
