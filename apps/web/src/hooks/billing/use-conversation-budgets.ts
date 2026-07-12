import { useQuery, type UseQueryResult, useMutation, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotentHeaders } from '@/lib/idempotent-mutation.js';

/**
 * The group-budget display, as the rebuilt `GET /conversations/:id/budgets`
 * serves it: every money field is a canonical `NanoUSD` string (negative-capable
 * for `ownerBalanceNanoUsd` — the owner's purchased wallet can be overdrawn).
 * `effectiveRemainingNanoUsd` is the backend's own `min(member cap remaining,
 * conversation cap remaining, owner balance)` — the exact value admission gates
 * on — so the frontend never re-derives it. A non-owner viewer receives only
 * their own member row; the owner receives every non-owner member's.
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

/** Cents (the modal's edit unit) → canonical NanoUSD string (1 cent = 10^7 nano-USD). */
function centsToNanoUsd(budgetCents: number): string {
  return (BigInt(budgetCents) * 10_000_000n).toString();
}

export function useConversationBudgets(
  conversationId: string | null
): UseQueryResult<ConversationBudgetsResponse> {
  return useQuery<ConversationBudgetsResponse>({
    queryKey: budgetKeys.conversation(conversationId ?? ''),
    queryFn: () =>
      fetchJson<ConversationBudgetsResponse>(
        client.conversations[':conversationId'].budgets.$get({
          param: { conversationId: conversationId ?? '' },
        })
      ),
    enabled: !!conversationId,
    staleTime: Infinity,
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
