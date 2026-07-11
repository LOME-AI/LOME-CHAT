import { useQuery, type UseQueryResult, useMutation, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import type { UserTier } from '@hushbox/shared';

export interface ConversationBudgetsResponse {
  conversationBudget: string;
  totalSpent: string;
  memberBudgets: {
    memberId: string;
    userId: string | null;
    linkId: string | null;
    privilege: string;
    budget: string;
    spent: string;
  }[];
  effectiveDollars: number;
  ownerTier: UserTier;
  ownerBalanceDollars: number;
  memberBudgetDollars: number;
}

export const budgetKeys = {
  all: ['budgets'] as const,
  conversation: (conversationId: string) => [...budgetKeys.all, conversationId] as const,
};

/** Legacy cents → canonical NanoUSD string (1 cent = 10^7 nano-USD). */
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
    mutationFn: ({
      conversationId,
      memberId,
      budgetCents,
    }: {
      conversationId: string;
      memberId: string;
      budgetCents: number;
    }) =>
      fetchJson(
        client.conversations[':conversationId'].member[':memberId'].budget.$put({
          param: { conversationId, memberId },
          json: { capNanoUsd: centsToNanoUsd(budgetCents) },
        })
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
    mutationFn: ({
      conversationId,
      budgetCents,
    }: {
      conversationId: string;
      budgetCents: number;
    }) =>
      fetchJson(
        client.conversations[':conversationId'].budget.$put({
          param: { conversationId },
          json: { capNanoUsd: centsToNanoUsd(budgetCents) },
        })
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(variables.conversationId),
      });
    },
  });
}
