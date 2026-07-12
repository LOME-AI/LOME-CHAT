import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotentHeaders } from '@/lib/idempotent-mutation.js';
import { budgetKeys } from '@/hooks/billing/use-conversation-budgets.js';
import { chatKeys } from '@/hooks/chat/chat.js';
import type { StreamChatRotation } from '@hushbox/shared';
import type { QueryClient } from '@tanstack/react-query';

export function useMuteConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ conversationId, muted }: { conversationId: string; muted: boolean }) =>
      fetchJson(
        client.conversations[':conversationId'].membership.mute.$patch({
          param: { conversationId },
          json: { muted },
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
    },
  });
}

export function usePinConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ conversationId, pinned }: { conversationId: string; pinned: boolean }) =>
      fetchJson(
        client.conversations[':conversationId'].membership.pin.$patch({
          param: { conversationId },
          json: { pinned },
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
    },
  });
}

function invalidateMemberAndBudget(
  queryClient: QueryClient
): (_data: unknown, variables: { conversationId: string }) => Promise<void> {
  return async (_data, variables) => {
    await queryClient.invalidateQueries({
      queryKey: memberKeys.list(variables.conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: budgetKeys.conversation(variables.conversationId),
    });
  };
}

export const memberKeys = {
  all: ['members'] as const,
  list: (conversationId: string) => [...memberKeys.all, conversationId] as const,
};

export function useConversationMembers(conversationId: string | null): ReturnType<typeof useQuery> {
  return useQuery({
    queryKey: memberKeys.list(conversationId ?? ''),
    queryFn: () =>
      fetchJson(
        client.conversations[':conversationId'].members.$get({
          param: { conversationId: conversationId ?? '' },
        })
      ),
    enabled: !!conversationId,
  });
}

export function useAddMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      conversationId: string;
      userId: string;
      privilege: string;
      giveFullHistory: boolean;
      wrap?: string;
      rotation?: StreamChatRotation;
    }) =>
      fetchJson(
        client.conversations[':conversationId'].members.$post(
          {
            param: { conversationId: input.conversationId },
            json: {
              userId: input.userId,
              privilege: input.privilege as 'read' | 'write' | 'admin',
              giveFullHistory: input.giveFullHistory,
              ...(input.wrap !== undefined && { wrap: input.wrap }),
              ...(input.rotation !== undefined && { rotation: input.rotation }),
            },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: invalidateMemberAndBudget(queryClient),
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      conversationId: string;
      memberId: string;
      rotation: StreamChatRotation;
    }) =>
      fetchJson(
        client.conversations[':conversationId'].members[':memberId'].remove.$post(
          {
            param: { conversationId: input.conversationId, memberId: input.memberId },
            json: { rotation: input.rotation },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: invalidateMemberAndBudget(queryClient),
  });
}

export function useChangePrivilege() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { conversationId: string; memberId: string; privilege: string }) =>
      fetchJson(
        client.conversations[':conversationId'].member[':memberId'].privilege.$patch(
          {
            param: { conversationId: input.conversationId, memberId: input.memberId },
            json: { privilege: input.privilege as 'read' | 'write' | 'admin' | 'owner' },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: invalidateMemberAndBudget(queryClient),
  });
}

export function useLeaveConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { conversationId: string; rotation?: StreamChatRotation }) =>
      fetchJson(
        client.conversations[':conversationId'].leave.$post(
          {
            param: { conversationId: input.conversationId },
            json: { ...(input.rotation !== undefined && { rotation: input.rotation }) },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
      queryClient.removeQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: memberKeys.list(variables.conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(variables.conversationId),
      });
    },
  });
}

export function useAcceptMembership() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ conversationId }: { conversationId: string }) =>
      fetchJson(
        client.conversations[':conversationId'].membership.accept.$patch({
          param: { conversationId },
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
    },
  });
}

/**
 * Decline a pending invitation. Server-side this requires `acceptedAt IS NULL`
 * — once the user has accepted, declining is no longer valid and they must
 * `leaveConversation` (which rotates the epoch). The inbox UI only shows the
 * decline button while the invite is pending, so this path is reached from
 * exactly one place.
 */
export function useDeclineInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ conversationId }: { conversationId: string }) =>
      fetchJson(
        client.conversations[':conversationId'].membership.decline.$post({
          param: { conversationId },
        })
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
      queryClient.removeQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
    },
  });
}
