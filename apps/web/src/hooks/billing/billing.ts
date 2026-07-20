import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotentHeaders } from '@/lib/idempotent-mutation.js';
import type {
  GetBalanceResponse,
  ListTransactionsResponse,
  LedgerEntryKind,
} from '@hushbox/shared';

export const billingKeys = {
  all: ['billing'] as const,
  balance: () => [...billingKeys.all, 'balance'] as const,
  transactions: () => [...billingKeys.all, 'transactions'] as const,
  transactionList: (cursor?: string) => [...billingKeys.transactions(), { cursor }] as const,
};

/** Reusable query options for balance. Shared by hooks and route loaders. */
export function balanceQueryOptions(): {
  queryKey: readonly ['billing', 'balance'];
  queryFn: () => Promise<GetBalanceResponse>;
} {
  return {
    queryKey: billingKeys.balance(),
    queryFn: () => fetchJson(client.billing.balance.$get()),
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
  type?: LedgerEntryKind;
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
      return fetchJson(client.billing.transactions.$get({ query }));
    },
    enabled,
  });
}

/** The `POST /billing/payments` wire shape (Pattern-D single-call charge). */
export interface InitiatePaymentResponse {
  paymentId: string;
  /**
   * `awaiting_webhook` — the processor approved; the credit lands via webhook +
   * the `payment.verify.v1` job (confirmed client-side by polling the balance).
   * `completed` is not returned by the current backend but is accepted so a
   * synchronous settlement never breaks the caller.
   */
  status: 'awaiting_webhook' | 'completed' | 'failed' | 'expired';
  amountNanoUsd: string;
}

export interface InitiatePaymentInput {
  amountNanoUsd: string;
  cardToken: string;
  customerCode: string;
}

/**
 * Pattern D: one pre-claimed charge. Tokenize the card first (Helcim.js), then
 * call this with the resulting token + customer code and the amount as NanoUSD.
 * The Idempotency-Key makes a retried charge a no-op that replays the original
 * outcome. The credit itself lands asynchronously (webhook + verify job), so the
 * caller confirms arrival by polling the balance — there is no status route.
 */
export function useInitiatePayment(): ReturnType<
  typeof useMutation<InitiatePaymentResponse, Error, InitiatePaymentInput>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: InitiatePaymentInput): Promise<InitiatePaymentResponse> =>
      // web status union adds 'completed' the wire never emits (see status field doc above) — cast bridges the drift; see F-49 follow-up
      fetchJson<InitiatePaymentResponse>(
        client.billing.payments.$post({ json: variables }, idempotentHeaders(variables))
      ),
    onSuccess: async (data) => {
      // A synchronous `completed` would credit the wallet immediately; refresh
      // the balance/history so the UI reflects it without waiting for a poll.
      if (data.status === 'completed') {
        await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        await queryClient.invalidateQueries({ queryKey: billingKeys.transactions() });
      }
    },
  });
}
