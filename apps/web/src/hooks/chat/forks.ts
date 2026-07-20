import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client';
import { chatKeys, type ConversationDetailResponse } from '@/hooks/chat/chat';
import { idempotentHeaders } from '@/lib/idempotent-mutation.js';
import type { ForkResponse } from '@/lib/api';

export const forkKeys = {
  forConversation: (conversationId: string) => ['forks', conversationId] as const,
};

/** Shared queryFn — same as useConversation. TanStack Query deduplicates. */
function conversationQueryFunction(id: string): () => Promise<ConversationDetailResponse> {
  return async (): Promise<ConversationDetailResponse> => {
    return fetchJson(
      client.conversations[':conversationId'].$get({ param: { conversationId: id } })
    );
  };
}

export function useForks(
  conversationId: string
): ReturnType<typeof useQuery<ConversationDetailResponse, Error, ForkResponse[]>> {
  return useQuery({
    queryKey: chatKeys.conversation(conversationId),
    queryFn: conversationQueryFunction(conversationId),
    select: (data): ForkResponse[] => data.forks,
    enabled: !!conversationId,
  });
}

interface CreateForkParams {
  id: string;
  conversationId: string;
  fromMessageId: string;
  name?: string;
}

interface CreateForkResult {
  forks: ForkResponse[];
}

export function useCreateFork(): ReturnType<
  typeof useMutation<CreateForkResult, Error, CreateForkParams>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: CreateForkParams): Promise<CreateForkResult> => {
      const { conversationId, ...body } = params;
      return fetchJson(
        client.conversations[':conversationId'].forks.$post(
          {
            param: { conversationId },
            json: body,
          },
          idempotentHeaders(params)
        )
      );
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
    },
  });
}

interface DeleteForkParams {
  conversationId: string;
  forkId: string;
}

export function useDeleteFork(): ReturnType<typeof useMutation<unknown, Error, DeleteForkParams>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: DeleteForkParams): Promise<unknown> => {
      return fetchJson(
        client.conversations[':conversationId'].forks[':forkId'].$delete(
          {
            param: { conversationId: params.conversationId, forkId: params.forkId },
          },
          idempotentHeaders(params)
        )
      );
    },
    onSuccess: (_data, variables) => {
      queryClient.setQueryData<ConversationDetailResponse>(
        chatKeys.conversation(variables.conversationId),
        (old) => (old ? { ...old, forks: old.forks.filter((f) => f.id !== variables.forkId) } : old)
      );
      void queryClient.invalidateQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
    },
  });
}

interface RenameForkParams {
  conversationId: string;
  forkId: string;
  name: string;
}

interface RenameForkResult {
  fork: ForkResponse;
}

export function useRenameFork(): ReturnType<
  typeof useMutation<RenameForkResult, Error, RenameForkParams>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: RenameForkParams): Promise<RenameForkResult> => {
      return fetchJson(
        client.conversations[':conversationId'].forks[':forkId'].$patch(
          {
            param: { conversationId: params.conversationId, forkId: params.forkId },
            json: { name: params.name },
          },
          idempotentHeaders(params)
        )
      );
    },
    onSuccess: (_data, variables) => {
      queryClient.setQueryData<ConversationDetailResponse>(
        chatKeys.conversation(variables.conversationId),
        (old) =>
          old
            ? {
                ...old,
                forks: old.forks.map((f) =>
                  f.id === variables.forkId ? { ...f, name: variables.name } : f
                ),
              }
            : old
      );
    },
  });
}

export { type ForkResponse } from '@/lib/api';
