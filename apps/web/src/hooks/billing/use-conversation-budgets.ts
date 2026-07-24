import { useQuery, type UseQueryResult, useMutation, useQueryClient } from '@tanstack/react-query';
import { centsToNanoUsd } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotentHeaders } from '@/lib/idempotent-mutation.js';

/**
 * The group-budget display, as the rebuilt `GET /conversations/:id/budgets`
 * serves it: every money field is a canonical `NanoUSD` string (negative-capable
 * for `ownerBalanceNanoUsd` — the owner's purchased wallet can be overdrawn).
 * `effectiveRemainingNanoUsd` is the backend's own hold-aware `min(member cap
 * remaining − member holds, conversation cap remaining − conversation holds,
 * owner balance)` — the exact value admission gates on — so the frontend never
 * re-derives it. The owner-balance dimension stays RAW (never hold-aware) by
 * ruling: members must not infer owner activity. A non-owner viewer receives
 * only their own member row; the owner receives every non-owner member's.
 */
export interface ConversationBudgetsResponse {
  conversationCapNanoUsd: string;
  conversationSpentNanoUsd: string;
  ownerBalanceNanoUsd: string;
  members: {
    memberId: string;
    userId: string | null;
    username: string | null;
    privilege: string;
    capNanoUsd: string;
    spentNanoUsd: string;
    effectiveRemainingNanoUsd: string;
  }[];
}

export const budgetKeys = {
  all: ['budgets'] as const,
  conversation: (conversationId: string) => [...budgetKeys.all, conversationId] as const,
};

export function useConversationBudgets(
  conversationId: string | null
): UseQueryResult<ConversationBudgetsResponse> {
  return useQuery<ConversationBudgetsResponse>({
    queryKey: budgetKeys.conversation(conversationId ?? ''),
    queryFn: () =>
      fetchJson(
        client.conversations[':conversationId'].budgets.$get({
          param: { conversationId: conversationId ?? '' },
        })
      ),
    // No staleTime pin (global default applies): the served remaining is
    // hold-aware, so it changes with runs the client may have no socket to —
    // an Infinity pin would keep a remounted view on that stale snapshot
    // forever. Live freshness rides the WS invalidations (run-started,
    // run-finished, ws-ready catch-up) plus the budget-edit mutations below.
    enabled: !!conversationId,
  });
}

export function useUpdateMemberBudget() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { conversationId: string; memberId: string; budgetCents: number }) =>
      fetchJson(
        client.conversations[':conversationId'].member[':memberId'].budget.$put(
          {
            param: { conversationId: variables.conversationId, memberId: variables.memberId },
            json: { capNanoUsd: centsToNanoUsd(variables.budgetCents) },
          },
          idempotentHeaders(variables)
        )
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(variables.conversationId),
      });
    },
  });
}

export function useUpdateConversationBudget() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { conversationId: string; budgetCents: number }) =>
      fetchJson(
        client.conversations[':conversationId'].budget.$put(
          {
            param: { conversationId: variables.conversationId },
            json: { capNanoUsd: centsToNanoUsd(variables.budgetCents) },
          },
          idempotentHeaders(variables)
        )
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(variables.conversationId),
      });
    },
  });
}
