import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import { unportedEndpoint } from '@/lib/unported-endpoint.js';
import { useAuthStore } from '@/lib/auth.js';
import { getLinkGuestAuth } from '@/lib/link-guest-auth.js';
import { budgetKeys } from '@/hooks/billing/use-conversation-budgets.js';
import type { StreamChatRotation } from '@hushbox/shared';
import type { QueryClient } from '@tanstack/react-query';

function invalidateLinkAndBudget(
  queryClient: QueryClient
): (_data: unknown, variables: { conversationId: string }) => Promise<void> {
  return async (_data, variables) => {
    await queryClient.invalidateQueries({
      queryKey: linkKeys.list(variables.conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: budgetKeys.conversation(variables.conversationId),
    });
  };
}

export const linkKeys = {
  all: ['links'] as const,
  list: (conversationId: string) => [...linkKeys.all, conversationId] as const,
};

export function useConversationLinks(conversationId: string | null): ReturnType<typeof useQuery> {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: linkKeys.list(conversationId ?? ''),
    queryFn: () =>
      fetchJson(
        client.conversations[':conversationId'].links.$get({
          param: { conversationId: conversationId ?? '' },
        })
      ),
    enabled: (!!user || !!getLinkGuestAuth()) && !!conversationId,
  });
}

export function useCreateLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      linkPublicKey,
      memberWrap,
      privilege,
      giveFullHistory,
      displayName,
      rotation,
    }: {
      conversationId: string;
      linkPublicKey: string;
      memberWrap: string;
      privilege: string;
      giveFullHistory: boolean;
      displayName?: string;
      rotation?: StreamChatRotation;
    }) =>
      fetchJson(
        client.conversations[':conversationId'].links.$post({
          param: { conversationId },
          json: {
            linkPublicKey,
            memberWrap,
            privilege: privilege as 'read' | 'write',
            giveFullHistory,
            ...(displayName !== undefined && { displayName }),
            ...(rotation !== undefined && { rotation }),
          },
        })
      ),
    onSuccess: invalidateLinkAndBudget(queryClient),
  });
}

export function useChangeLinkPrivilege() {
  const queryClient = useQueryClient();

  return useMutation({
    // UNPORTED: the rebuilt backend has no link-privilege mutation (links
    // carry their privilege on the guest member row; only revoke exists).
    mutationFn: (_input: { conversationId: string; linkId: string; privilege: 'read' | 'write' }) =>
      unportedEndpoint('PATCH /api/links/:conversationId/:linkId/privilege'),
    onSuccess: invalidateLinkAndBudget(queryClient),
  });
}

export function useRevokeLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      linkId,
      rotation,
    }: {
      conversationId: string;
      linkId: string;
      rotation: StreamChatRotation;
    }) =>
      fetchJson(
        client.conversations[':conversationId'].links[':linkId'].revoke.$post({
          param: { conversationId, linkId },
          json: { rotation },
        })
      ),
    onSuccess: invalidateLinkAndBudget(queryClient),
  });
}
