import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/lib/api-client.js', () => ({
  client: {
    conversations: {
      ':conversationId': {
        budgets: { $get: vi.fn() },
        member: {
          ':memberId': {
            budget: { $put: vi.fn() },
          },
        },
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
    useMutation: vi.fn(actual.useMutation),
    useQueryClient: vi.fn(actual.useQueryClient),
  };
});

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import {
  budgetKeys,
  useConversationBudgets,
  useUpdateMemberBudget,
  type ConversationBudgetsResponse,
} from '@/hooks/billing/use-conversation-budgets.js';

const mockedUseQuery = vi.mocked(useQuery);
const mockedUseMutation = vi.mocked(useMutation);
const mockedUseQueryClient = vi.mocked(useQueryClient);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client);

describe('budgetKeys', () => {
  it('produces all key', () => {
    expect(budgetKeys.all).toEqual(['budgets']);
  });

  it('produces conversation key with conversationId', () => {
    expect(budgetKeys.conversation('conv-1')).toEqual(['budgets', 'conv-1']);
  });
});

describe('useConversationBudgets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enables the query when conversationId is provided', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationBudgets('conv-1'));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: budgetKeys.conversation('conv-1'),
        enabled: true,
      })
    );
  });

  it('disables the query when conversationId is null', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationBudgets(null));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: budgetKeys.conversation(''),
        enabled: false,
      })
    );
  });

  it('uses staleTime Infinity to prevent refetching in sidebar', () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationBudgets('conv-1'));

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        staleTime: Infinity,
      })
    );
  });

  it('returns typed data with effectiveDollars, ownerTier, and ownerBalanceDollars', () => {
    const mockData: ConversationBudgetsResponse = {
      conversationBudget: '10.00',
      totalSpent: '2.00',
      memberBudgets: [],
      effectiveDollars: 8,
      ownerTier: 'paid',
      ownerBalanceDollars: 50,
      memberBudgetDollars: 8,
    };
    mockedUseQuery.mockReturnValue({
      data: mockData,
      isSuccess: true,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => useConversationBudgets('conv-1'));

    expect(result.current.data).toEqual(
      expect.objectContaining({
        effectiveDollars: 8,
        ownerTier: 'paid',
        ownerBalanceDollars: 50,
      })
    );
  });

  it('calls the correct client path in queryFn', async () => {
    mockedUseQuery.mockReturnValue({ data: undefined } as ReturnType<typeof useQuery>);

    renderHook(() => useConversationBudgets('conv-1'));

    const queryFunction = mockedUseQuery.mock.calls[0]![0].queryFn as () => Promise<unknown>;
    await queryFunction();

    expect(mockedClient.conversations[':conversationId'].budgets.$get).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });
});

describe('useUpdateMemberBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries: vi.fn(),
    } as unknown as ReturnType<typeof useQueryClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls useMutation with correct mutationFn', () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useUpdateMemberBudget());

    expect(mockedUseMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationFn: expect.any(Function),
      })
    );
  });

  it('passes correct parameters to the client', async () => {
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useUpdateMemberBudget());

    const mutationFunction = mockedUseMutation.mock.calls[0]![0].mutationFn as (args: {
      conversationId: string;
      memberId: string;
      budgetCents: number;
    }) => Promise<unknown>;

    await mutationFunction({ conversationId: 'conv-1', memberId: 'mem-1', budgetCents: 500 });

    expect(
      mockedClient.conversations[':conversationId'].member[':memberId'].budget.$put
    ).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1', memberId: 'mem-1' },
      // 500 cents = 5_000_000_000 nano-USD (canonical NanoUSD string)
      json: { capNanoUsd: '5000000000' },
    });
    expect(mockedFetchJson).toHaveBeenCalled();
  });

  it('invalidates budget list on success', async () => {
    const invalidateQueries = vi.fn();
    mockedUseQueryClient.mockReturnValue({
      invalidateQueries,
    } as unknown as ReturnType<typeof useQueryClient>);
    mockedUseMutation.mockReturnValue({} as ReturnType<typeof useMutation>);

    renderHook(() => useUpdateMemberBudget());

    const onSuccess = mockedUseMutation.mock.calls[0]![0].onSuccess as (
      data: unknown,
      variables: { conversationId: string; memberId: string; budgetCents: number },
      context: unknown
    ) => Promise<void>;

    await onSuccess(
      {},
      { conversationId: 'conv-1', memberId: 'mem-1', budgetCents: 500 },
      // eslint-disable-next-line unicorn/no-useless-undefined -- onSuccess requires three arguments
      undefined
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: budgetKeys.conversation('conv-1'),
    });
  });
});
