import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { decryptTextFromEpoch } from '@hushbox/crypto';
import { fromBase64, type MemberPrivilege } from '@hushbox/shared';
import { useAuthStore, useSession } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client';
import {
  getEpochKey,
  processKeyChain,
  subscribe as epochCacheSubscribe,
  getSnapshot as epochCacheSnapshot,
} from '@/lib/epoch-key-cache';
import type { KeyChainResponse } from '@/lib/epoch-key-cache';
import type {
  Conversation,
  ConversationListItem,
  MessageResponse,
  ConversationsResponse,
  ConversationResponse,
  CreateConversationRequest,
  CreateConversationResponse,
  UpdateConversationRequest,
  UpdateConversationResponse,
  DeleteConversationResponse,
} from '@/lib/api';

export const DECRYPTING_TITLE = 'Decrypting...';

export const chatKeys = {
  all: ['chat'] as const,
  conversations: () => [...chatKeys.all, 'conversations'] as const,
  conversation: (id: string) => [...chatKeys.conversations(), id] as const,
};

/** Shared queryFn for GET /conversations/:id. All conversation hooks share this. */
function conversationQueryFunction(id: string): () => Promise<ConversationResponse> {
  return async (): Promise<ConversationResponse> => {
    return fetchJson<ConversationResponse>(
      client.conversations[':conversationId'].$get({ param: { conversationId: id } })
    );
  };
}

/** Reusable query options for a single conversation. Shared by hooks and route loaders. */
export function conversationQueryOptions(id: string): {
  queryKey: readonly ['chat', 'conversations', string];
  queryFn: () => Promise<ConversationResponse>;
} {
  return {
    queryKey: chatKeys.conversation(id),
    queryFn: conversationQueryFunction(id),
  };
}

export function useConversations(): {
  data: ConversationListItem[] | undefined;
  isLoading: boolean;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
} {
  // Gate on useSession(), not useAuthStore: useSession masks the user under
  // link-guest auth, where the API client switches to `credentials: 'omit'`
  // and a user-scoped query would 401.
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);

  const query = useInfiniteQuery({
    queryKey: chatKeys.conversations(),
    queryFn: async ({ pageParam }): Promise<ConversationsResponse> => {
      const queryParams: Record<string, string> = {};
      if (pageParam) queryParams['cursor'] = pageParam;
      return fetchJson<ConversationsResponse>(client.conversations.$get({ query: queryParams }));
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    enabled: isAuthenticated,
  });

  const flatData = useMemo(
    () => query.data?.pages.flatMap((page) => page.conversations),
    [query.data]
  );

  return {
    data: flatData,
    isLoading: query.isLoading,
    fetchNextPage: () => {
      void query.fetchNextPage();
    },
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

/**
 * Returns conversations with titles eagerly decrypted.
 * Fetches key chains for all conversations in parallel so titles
 * are decrypted immediately — no lazy/deferred decryption.
 */
export function useDecryptedConversations(): {
  data: ConversationListItem[] | undefined;
  isLoading: boolean;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
} {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useConversations();
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const cacheVersion = useSyncExternalStore(epochCacheSubscribe, epochCacheSnapshot);

  const conversationsNeedingKeys = useMemo(() => {
    if (!data) return [];
    return data.filter((conv) => !getEpochKey(conv.id, conv.titleEpochNumber));
  }, [data, cacheVersion]);

  // Stable key for the batch query — only changes when the set of needed IDs changes
  const batchIds = useMemo(
    () => conversationsNeedingKeys.map((c) => c.id).toSorted((a, b) => a.localeCompare(b)),
    [conversationsNeedingKeys]
  );

  const batchResult = useQuery({
    queryKey: ['keys', 'batch', batchIds] as const,
    queryFn: async (): Promise<Record<string, KeyChainResponse>> => {
      // The endpoint returns `{ keys, missing }` — `missing` lists ids the
      // caller has no membership for (revoked, deleted, or not yet replicated
      // after a membership change). Dropping `missing` is intentional: the
      // conversation list refetch that fires after any membership-changing
      // event will re-derive `batchIds` without the missing entries on the
      // next render.
      const response = await fetchJson<{
        keys: Record<string, KeyChainResponse>;
        missing: string[];
      }>(
        client.conversations['member-keys'].batch.$get({
          query: { conversationIds: batchIds.join(',') },
        })
      );
      return response.keys;
    },
    staleTime: 1000 * 60 * 60,
    enabled: batchIds.length > 0 && !!accountPrivateKey,
  });

  useEffect(() => {
    if (!accountPrivateKey || !batchResult.data) return;
    for (const [convId, keyChain] of Object.entries(batchResult.data)) {
      processKeyChain(convId, keyChain, accountPrivateKey);
    }
  }, [batchResult.data, accountPrivateKey]);

  const decryptedData = useMemo(() => {
    if (!data) return;
    return data.map((conv): ConversationListItem => {
      const epochKey = getEpochKey(conv.id, conv.titleEpochNumber);
      if (!epochKey || !conv.title) return { ...conv, title: DECRYPTING_TITLE };
      try {
        return { ...conv, title: decryptTextFromEpoch(epochKey, fromBase64(conv.title)) };
      } catch {
        return { ...conv, title: 'Encrypted conversation' };
      }
    });
  }, [data, cacheVersion]);

  return { data: decryptedData, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage };
}

export type ConversationWithCaller = Conversation & {
  callerId: string;
  callerPrivilege: MemberPrivilege;
};

export function useConversation(
  id: string
): ReturnType<typeof useQuery<ConversationResponse, Error, ConversationWithCaller>> {
  return useQuery({
    ...conversationQueryOptions(id),
    select: (data): ConversationWithCaller => ({
      ...data.conversation,
      callerId: data.callerId,
      callerPrivilege: data.privilege,
    }),
    enabled: !!id,
  });
}

export function useMessages(
  conversationId: string
): ReturnType<typeof useQuery<ConversationResponse, Error, MessageResponse[]>> {
  return useQuery({
    ...conversationQueryOptions(conversationId),
    select: (data): MessageResponse[] => data.messages,
    enabled: !!conversationId,
  });
}

export function useCreateConversation(): ReturnType<
  typeof useMutation<CreateConversationResponse, Error, CreateConversationRequest>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateConversationRequest): Promise<CreateConversationResponse> => {
      return fetchJson<CreateConversationResponse>(client.conversations.$post({ json: data }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}

export function useDeleteConversation(): ReturnType<
  typeof useMutation<DeleteConversationResponse, Error, string>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string): Promise<DeleteConversationResponse> => {
      return fetchJson<DeleteConversationResponse>(
        client.conversations[':conversationId'].$delete({ param: { conversationId } })
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}

export function useUpdateConversation(): ReturnType<
  typeof useMutation<
    UpdateConversationResponse,
    Error,
    { conversationId: string; data: UpdateConversationRequest }
  >
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      conversationId,
      data,
    }: {
      conversationId: string;
      data: UpdateConversationRequest;
    }): Promise<UpdateConversationResponse> => {
      return fetchJson<UpdateConversationResponse>(
        client.conversations[':conversationId'].$patch({
          param: { conversationId },
          json: data,
        })
      );
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}
