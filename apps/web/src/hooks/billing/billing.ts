import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client.js';
import { unportedEndpoint } from '@/lib/unported-endpoint.js';
import type {
  GetBalanceResponse,
  ListTransactionsResponse,
  CreatePaymentResponse,
  ProcessPaymentResponse,
  GetPaymentStatusResponse,
  LedgerEntryType,
} from '@hushbox/shared';

export const billingKeys = {
  all: ['billing'] as const,
  balance: () => [...billingKeys.all, 'balance'] as const,
  transactions: () => [...billingKeys.all, 'transactions'] as const,
  transactionList: (cursor?: string) => [...billingKeys.transactions(), { cursor }] as const,
  payments: () => [...billingKeys.all, 'payments'] as const,
  payment: (id: string) => [...billingKeys.payments(), id] as const,
};

/** Reusable query options for balance. Shared by hooks and route loaders. */
export function balanceQueryOptions(): {
  queryKey: readonly ['billing', 'balance'];
  queryFn: () => Promise<GetBalanceResponse>;
} {
  return {
    queryKey: billingKeys.balance(),
    queryFn: () => fetchJson<GetBalanceResponse>(client.billing.balance.$get()),
  };
}

/**
 * Hook to fetch user's current balance.
 * Skips the API call for trial (unauthenticated) users unless `enabled` is explicitly set.
 */
export function useBalance(options?: {
  enabled?: boolean;
}): ReturnType<typeof useQuery<GetBalanceResponse, Error>> {
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);

  return useQuery({
    ...balanceQueryOptions(),
    enabled: options?.enabled ?? isAuthenticated,
  });
}

interface TransactionsOptions {
  cursor?: string;
  limit?: number;
  offset?: number;
  type?: LedgerEntryType;
  enabled?: boolean;
}

/**
 * Hook to fetch balance transaction history with cursor-based or offset-based pagination.
 */
export function useTransactions(
  options?: TransactionsOptions
): ReturnType<typeof useQuery<ListTransactionsResponse, Error>> {
  const { cursor, limit = 50, offset, type, enabled = true } = options ?? {};

  return useQuery({
    queryKey: [...billingKeys.transactions(), { cursor, limit, offset, type }] as const,
    queryFn: () => {
      const query: Record<string, string> = {};
      if (cursor) query['cursor'] = cursor;
      if (limit) query['limit'] = String(limit);
      if (offset !== undefined) query['offset'] = String(offset);
      if (type) query['type'] = type;
      return fetchJson<ListTransactionsResponse>(client.billing.transactions.$get({ query }));
    },
    enabled,
  });
}

/**
 * Hook to create a new payment record.
 * Returns the payment ID to use for processing.
 *
 * UNPORTED: the rebuilt backend collapsed the legacy create → process → poll
 * flow into one `POST /billing/payments` (amount + cardToken + customerCode +
 * Idempotency-Key in a single pre-claimed charge). There is no create-only
 * step, so this hook has no route until the payment-form flow is reshaped in
 * the UI-alignment task.
 */
export function useCreatePayment(): ReturnType<
  typeof useMutation<CreatePaymentResponse, Error, { amount: string }>
> {
  return useMutation({
    mutationFn: (_input: { amount: string }): Promise<CreatePaymentResponse> =>
      unportedEndpoint('POST /api/billing/payments (create-only step)'),
  });
}

/**
 * Hook to process a payment with a card token.
 * customerCode is required as Helcim links card tokens to customers.
 *
 * UNPORTED: the single-call `POST /billing/payments` needs the amount, which
 * this hook's contract does not carry (it lived on the legacy created payment
 * row). Repointing is the payment-form flow change owned by the UI-alignment
 * task.
 */
export function useProcessPayment(): ReturnType<
  typeof useMutation<
    ProcessPaymentResponse,
    Error,
    { paymentId: string; cardToken: string; customerCode: string }
  >
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (_input: {
      paymentId: string;
      cardToken: string;
      customerCode: string;
    }): Promise<ProcessPaymentResponse> =>
      unportedEndpoint('POST /api/billing/payments/:id/process'),
    onSuccess: async (data) => {
      if (data.status === 'completed') {
        await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        await queryClient.invalidateQueries({ queryKey: billingKeys.transactions() });
      }
    },
  });
}

/**
 * Hook to poll payment status.
 * Useful for awaiting webhook confirmation.
 *
 * UNPORTED: the rebuilt backend has no `GET /billing/payments/:id` — payment
 * settlement is confirmed by webhook + the `payment.verify.v1` job, and the
 * client-facing status surface is the UI-alignment task's to design.
 */
export function usePaymentStatus(
  paymentId: string | null,
  options?: { enabled?: boolean; refetchInterval?: number | false }
): ReturnType<typeof useQuery<GetPaymentStatusResponse, Error>> {
  const { enabled = true, refetchInterval = false } = options ?? {};

  return useQuery({
    queryKey: billingKeys.payment(paymentId ?? ''),
    queryFn: (): Promise<GetPaymentStatusResponse> =>
      unportedEndpoint('GET /api/billing/payments/:id'),
    enabled: enabled && !!paymentId,
    refetchInterval,
  });
}
