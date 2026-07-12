import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBalance } from '@/test-utils/balance-fixture';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useBalance,
  useTransactions,
  useInitiatePayment,
  billingKeys,
  balanceQueryOptions,
} from '@/hooks/billing/billing.js';

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/lib/api-client.js', () => ({
  client: {
    billing: {
      balance: { $get: vi.fn() },
      transactions: { $get: vi.fn() },
      payments: { $post: vi.fn() },
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

import { useSession } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';

const mockedUseSession = vi.mocked(useSession);
const mockedUseQuery = vi.mocked(useQuery);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client, true);

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

describe('useBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables the query when user is not authenticated (trial)', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: false });
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useBalance());

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: billingKeys.balance(),
        enabled: false,
      })
    );
  });

  it('enables the query when user is authenticated', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' }, session: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useBalance());

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: billingKeys.balance(),
        enabled: true,
      })
    );
  });

  it('disables the query when session is still loading with no user', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: true });
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useBalance());

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      })
    );
  });

  it('respects explicit enabled=true override even for unauthenticated users', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: false });
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useBalance({ enabled: true }));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
      })
    );
  });

  it('respects explicit enabled=false override for authenticated users', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' }, session: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useBalance({ enabled: false }));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      })
    );
  });
});

describe('balanceQueryOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns correct queryKey', () => {
    const options = balanceQueryOptions();
    expect(options.queryKey).toEqual(billingKeys.balance());
  });

  it('returns a callable queryFn', () => {
    const options = balanceQueryOptions();
    expect(typeof options.queryFn).toBe('function');
  });

  it('queryFn invokes the balance endpoint via fetchJson', async () => {
    const balanceResponse = makeBalance('12340000000');
    const mockResponsePromise = Promise.resolve(new Response());
    vi.mocked(mockedClient.billing.balance.$get).mockReturnValue(
      mockResponsePromise as unknown as ReturnType<typeof mockedClient.billing.balance.$get>
    );
    mockedFetchJson.mockResolvedValue(balanceResponse);

    const result = await balanceQueryOptions().queryFn();

    expect(mockedClient.billing.balance.$get).toHaveBeenCalled();
    expect(mockedFetchJson).toHaveBeenCalledWith(mockResponsePromise);
    expect(result).toBe(balanceResponse);
  });
});

describe('billingKeys', () => {
  it('produces stable key arrays for transactionList with cursor', () => {
    expect(billingKeys.transactionList('cur-1')).toEqual([
      'billing',
      'transactions',
      { cursor: 'cur-1' },
    ]);
  });

  it('produces stable key arrays for transactionList without cursor', () => {
    expect(billingKeys.transactionList()).toEqual([
      'billing',
      'transactions',
      { cursor: undefined },
    ]);
  });
});

describe('useTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQuery.mockReset();
    mockedUseQuery.mockImplementation(((options: { queryFn?: () => unknown }) => {
      // call queryFn so the closure executes and we can capture client args
      if (options.queryFn) {
        try {
          options.queryFn();
        } catch {
          /* swallow inside test instrumentation */
        }
      }
      return { data: undefined } as ReturnType<typeof useQuery>;
    }) as unknown as typeof useQuery);
  });

  it('passes default limit (50) when called without options', () => {
    vi.mocked(mockedClient.billing.transactions.$get).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.billing.transactions.$get
      >
    );

    renderHook(() => useTransactions());

    expect(mockedClient.billing.transactions.$get).toHaveBeenCalledWith({
      query: { limit: '50' },
    });
  });

  it('forwards cursor, offset, and type into the query', () => {
    vi.mocked(mockedClient.billing.transactions.$get).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.billing.transactions.$get
      >
    );

    renderHook(() => useTransactions({ cursor: 'abc', limit: 10, offset: 20, type: 'deposit' }));

    expect(mockedClient.billing.transactions.$get).toHaveBeenCalledWith({
      query: { cursor: 'abc', limit: '10', offset: '20', type: 'deposit' },
    });
  });

  it('omits cursor and offset when not provided', () => {
    vi.mocked(mockedClient.billing.transactions.$get).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.billing.transactions.$get
      >
    );

    renderHook(() => useTransactions({ limit: 25 }));

    expect(mockedClient.billing.transactions.$get).toHaveBeenCalledWith({
      query: { limit: '25' },
    });
  });

  it('respects enabled=false', () => {
    renderHook(() => useTransactions({ enabled: false }));

    expect(mockedUseQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('defaults enabled to true', () => {
    renderHook(() => useTransactions());

    expect(mockedUseQuery).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('omits limit query param when limit is explicitly 0', () => {
    vi.mocked(mockedClient.billing.transactions.$get).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.billing.transactions.$get
      >
    );

    renderHook(() => useTransactions({ limit: 0 }));

    expect(mockedClient.billing.transactions.$get).toHaveBeenCalledWith({
      query: {},
    });
  });
});

describe('useInitiatePayment', () => {
  const input = {
    amountNanoUsd: '100000000000',
    cardToken: 'tok-1',
    customerCode: 'cust-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQuery.mockImplementation((() => ({
      data: undefined,
    })) as unknown as typeof useQuery);
  });

  it('posts amountNanoUsd + cardToken + customerCode with an Idempotency-Key', async () => {
    vi.mocked(mockedClient.billing.payments.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.billing.payments.$post
      >
    );
    mockedFetchJson.mockResolvedValue({
      paymentId: 'pay-1',
      status: 'awaiting_webhook',
      amountNanoUsd: '100000000000',
    });

    const { result } = renderHook(() => useInitiatePayment(), { wrapper: createWrapper() });

    const response = await result.current.mutateAsync(input);

    expect(mockedClient.billing.payments.$post).toHaveBeenCalledWith(
      { json: input },
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
    expect(response).toEqual({
      paymentId: 'pay-1',
      status: 'awaiting_webhook',
      amountNanoUsd: '100000000000',
    });
  });

  it('invalidates balance and transactions on a synchronous completed charge', async () => {
    vi.mocked(mockedClient.billing.payments.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.billing.payments.$post
      >
    );
    mockedFetchJson.mockResolvedValue({
      paymentId: 'pay-2',
      status: 'completed',
      amountNanoUsd: '100000000000',
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }
    Wrapper.displayName = 'CompletedWrapper';

    const { result } = renderHook(() => useInitiatePayment(), { wrapper: Wrapper });

    await result.current.mutateAsync(input);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: billingKeys.balance() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: billingKeys.transactions() });
  });

  it('does not invalidate caches for an awaiting_webhook charge', async () => {
    vi.mocked(mockedClient.billing.payments.$post).mockReturnValue(
      Promise.resolve(new Response()) as unknown as ReturnType<
        typeof mockedClient.billing.payments.$post
      >
    );
    mockedFetchJson.mockResolvedValue({
      paymentId: 'pay-3',
      status: 'awaiting_webhook',
      amountNanoUsd: '100000000000',
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
      return createElement(QueryClientProvider, { client: queryClient }, children);
    }
    Wrapper.displayName = 'AwaitingWrapper';

    const { result } = renderHook(() => useInitiatePayment(), { wrapper: Wrapper });

    await result.current.mutateAsync(input);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
