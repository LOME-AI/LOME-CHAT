import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { useDeleteAccountInit, useDeleteAccountFinish } from '@/hooks/auth/use-delete-account';

const initMock = vi.fn((_args: unknown) => Promise.resolve(new Response()));
const finishMock = vi.fn((_args: unknown) => Promise.resolve(new Response()));

vi.mock('@/lib/api-client', () => ({
  client: {
    auth: {
      account: {
        delete: {
          init: { $post: (args: unknown) => initMock(args) },
          finish: { $post: (args: unknown) => finishMock(args) },
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/api-client';

const mockFetchJson = vi.mocked(fetchJson);

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

describe('useDeleteAccountInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the delete-account init endpoint with the ke1 body and returns ke2', async () => {
    const ke2Bytes = [10, 20, 30];
    mockFetchJson.mockResolvedValueOnce({ ke2: ke2Bytes });

    const { result } = renderHook(() => useDeleteAccountInit(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({ ke1: [1, 2, 3] });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(initMock).toHaveBeenCalledWith({ json: { ke1: [1, 2, 3] } });
    expect(result.current.data).toEqual({ ke2: ke2Bytes });
  });

  it('propagates errors from the init endpoint so the caller can map them', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('INCORRECT_PASSWORD'));

    const { result } = renderHook(() => useDeleteAccountInit(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({ ke1: [1, 2, 3] });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe('useDeleteAccountFinish', () => {
  const TEST_SESSION_ID = '00000000-0000-4000-8000-deadbeefdead';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls the delete-account finish endpoint with the full payload and resolves to void on 204', async () => {
    mockFetchJson.mockResolvedValueOnce({});

    const { result } = renderHook(() => useDeleteAccountFinish(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({
        ke3: [4, 5, 6],
        totpCode: '123456',
        confirmationPhrase: 'delete my account',
        deleteAccountSessionId: TEST_SESSION_ID,
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(finishMock).toHaveBeenCalledWith({
      json: {
        ke3: [4, 5, 6],
        totpCode: '123456',
        confirmationPhrase: 'delete my account',
        deleteAccountSessionId: TEST_SESSION_ID,
      },
    });
  });

  it('omits totpCode when not supplied so the API accepts users without 2FA', async () => {
    mockFetchJson.mockResolvedValueOnce({});

    const { result } = renderHook(() => useDeleteAccountFinish(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({
        ke3: [4, 5, 6],
        confirmationPhrase: 'delete my account',
        deleteAccountSessionId: TEST_SESSION_ID,
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(finishMock).toHaveBeenCalledWith({
      json: {
        ke3: [4, 5, 6],
        confirmationPhrase: 'delete my account',
        deleteAccountSessionId: TEST_SESSION_ID,
      },
    });
  });

  it('propagates errors from the finish endpoint so the caller can render legacyFriendlyErrorMessage', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('NO_PENDING_DELETE_ACCOUNT'));

    const { result } = renderHook(() => useDeleteAccountFinish(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({
        ke3: [4, 5, 6],
        confirmationPhrase: 'delete my account',
        deleteAccountSessionId: TEST_SESSION_ID,
      });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });

  // Production throws ApiError(code, status, body) — not generic Error — and the
  // modal extracts code from error.message + details from error.data.details.
  // This test pins the contract so a future hook refactor that swallows or
  // re-wraps ApiError fails loudly.
  it('preserves the ApiError shape (message=code, data.details) from fetchJson', async () => {
    class TestApiError extends Error {
      constructor(
        message: string,
        public status: number,
        public data?: unknown
      ) {
        super(message);
        this.name = 'ApiError';
      }
    }
    const thrown = new TestApiError('DELETE_ACCOUNT_LOCKED', 403, {
      code: 'DELETE_ACCOUNT_LOCKED',
      details: { retryAfterSeconds: 3600 },
    });
    mockFetchJson.mockRejectedValueOnce(thrown);

    const { result } = renderHook(() => useDeleteAccountFinish(), { wrapper: createWrapper() });
    act(() => {
      result.current.mutate({
        ke3: [4, 5, 6],
        confirmationPhrase: 'delete my account',
        deleteAccountSessionId: TEST_SESSION_ID,
      });
    });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    const err = result.current.error as TestApiError | null;
    expect(err).toBe(thrown);
    expect(err?.message).toBe('DELETE_ACCOUNT_LOCKED');
    expect(err?.status).toBe(403);
    expect(err?.data).toEqual({
      code: 'DELETE_ACCOUNT_LOCKED',
      details: { retryAfterSeconds: 3600 },
    });
  });
});
