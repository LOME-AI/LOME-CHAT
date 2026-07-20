import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { decryptTextFromEpoch } from '@hushbox/crypto';
import {
  fromBase64,
  type MemberPrivilege,
  type ContentItemResponse,
  type MembershipView,
  type GetConversationResponse,
} from '@hushbox/shared';
import { useAuthStore, useSession } from '@/lib/auth';
import { client, fetchJson } from '@/lib/api-client';
import { idempotentHeaders } from '@/lib/idempotent-mutation.js';
import { keyKeys } from '@/hooks/crypto/keys';
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
  // Message history is a child of the conversation key so the existing
  // `invalidateQueries({ queryKey: conversation(id) })` (prefix match, fired on
  // run-finished / regenerate) also refetches history.
  messages: (id: string) => [...chatKeys.conversation(id), 'messages'] as const,
};

/**
 * The caller's membership facts for a conversation, as returned by
 * GET /conversations/:id (`membership` object). Single-sourced from the shared
 * wire contract (`membershipViewSchema`).
 */
export type ConversationMembership = MembershipView;

/**
 * Wire shape of GET /conversations/:id, single-sourced from the shared
 * `getConversationResponseSchema` (server serializer of record): the
 * conversation record, the caller's `membership`, and the forks. Message
 * history is served separately by GET /conversations/:id/messages.
 */
export type ConversationDetailResponse = GetConversationResponse;

/** One message from GET /conversations/:id/messages (the slim history view). */
interface HistoryContentItem {
  id: string;
  position: number;
  contentType: 'text' | 'image' | 'audio' | 'video';
  mimeType: string | null;
  byteLength: number | null;
  encryptedBlob: string | null;
  /** The generating model id, or null for user/system items. */
  modelName: string | null;
  /** Total billed cost anchored to this item as a canonical NanoUSD string, or null. */
  cost: string | null;
  isSmartModel: boolean;
}

interface HistoryMessage {
  id: string;
  parentMessageId: string | null;
  sequenceNumber: number;
  epochNumber: number;
  senderType: 'user' | 'assistant' | 'system';
  senderId: string | null;
  wrappedContentKey: string;
  batchId: string;
  contentItems: HistoryContentItem[];
}

/**
 * Adapt the slim history content-item view to the `ContentItemResponse` the
 * decrypt pipeline (`useDecryptedMessages`) consumes. Fields the history view
 * does not carry (storageKey, dimensions) are null — text decryption needs only
 * `contentType` + `encryptedBlob`, and media needs `mimeType` + `sizeBytes`. The
 * settled display metadata the history read DOES carry — model name, billed cost
 * (a canonical NanoUSD string), and the smart-model flag — is mapped through so
 * settled messages render their cost, model, and Smart chip.
 */
function toContentItemResponse(item: HistoryContentItem): ContentItemResponse {
  return {
    id: item.id,
    contentType: item.contentType,
    position: item.position,
    encryptedBlob: item.encryptedBlob,
    storageKey: null,
    mimeType: item.mimeType,
    sizeBytes: item.byteLength,
    width: null,
    height: null,
    durationMs: null,
    modelName: item.modelName,
    cost: item.cost,
    isSmartModel: item.isSmartModel,
  };
}

/**
 * Adapt a history message to `MessageResponse`. `conversationId` is threaded
 * from the query (the history row omits it); `createdAt` is absent from the
 * history view, so it is empty (message order comes from `sequenceNumber`, not
 * timestamps). `system` senders collapse to `ai` for display parity.
 */
function toMessageResponse(msg: HistoryMessage, conversationId: string): MessageResponse {
  return {
    id: msg.id,
    conversationId,
    wrappedContentKey: msg.wrappedContentKey,
    senderType: msg.senderType === 'user' ? 'user' : 'ai',
    senderId: msg.senderId,
    epochNumber: msg.epochNumber,
    sequenceNumber: msg.sequenceNumber,
    parentMessageId: msg.parentMessageId,
    batchId: msg.batchId,
    createdAt: '',
    contentItems: msg.contentItems.map((item) => toContentItemResponse(item)),
  };
}

/**
 * Fetch the full message history, following the cursor to exhaustion so the
 * decrypt/fork pipeline sees every message at once — matching the old single
 * payload read. Pages ascend by `sequenceNumber`.
 */
async function fetchAllMessages(conversationId: string): Promise<MessageResponse[]> {
  const all: MessageResponse[] = [];
  let cursor: string | undefined;
  do {
    const query: Record<string, string> = {};
    if (cursor !== undefined) query['cursor'] = cursor;
    const page = await fetchJson(
      client.conversations[':conversationId'].messages.$get({
        param: { conversationId },
        query,
      })
    );
    for (const message of page.messages) all.push(toMessageResponse(message, conversationId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return all;
}

/** Shared queryFn for GET /conversations/:id. All conversation hooks share this. */
function conversationQueryFunction(id: string): () => Promise<ConversationDetailResponse> {
  return async (): Promise<ConversationDetailResponse> => {
    return fetchJson(
      client.conversations[':conversationId'].$get({ param: { conversationId: id } })
    );
  };
}

/** Reusable query options for a single conversation. Shared by hooks and route loaders. */
export function conversationQueryOptions(id: string): {
  queryKey: readonly ['chat', 'conversations', string];
  queryFn: () => Promise<ConversationDetailResponse>;
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
      return fetchJson(client.conversations.$get({ query: queryParams }));
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
    queryKey: keyKeys.batch(batchIds),
    queryFn: async (): Promise<Record<string, KeyChainResponse>> => {
      // The endpoint returns `{ keys, missing }` — `missing` lists ids the
      // caller has no membership for (revoked, deleted, or not yet replicated
      // after a membership change). Dropping `missing` is intentional: the
      // conversation list refetch that fires after any membership-changing
      // event will re-derive `batchIds` without the missing entries on the
      // next render.
      const response = await fetchJson(
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

export type ConversationWithCaller = Omit<Conversation, 'userId'> & {
  callerId: string;
  callerPrivilege: MemberPrivilege;
};

export function useConversation(
  id: string
): ReturnType<typeof useQuery<ConversationDetailResponse, Error, ConversationWithCaller>> {
  // The conversation payload no longer identifies the caller; the current user
  // id comes from the session (the account store), and privilege from the
  // caller's `membership`.
  const callerId = useAuthStore((s) => s.user?.id ?? '');
  return useQuery({
    ...conversationQueryOptions(id),
    select: (data): ConversationWithCaller => ({
      ...data.conversation,
      callerId,
      callerPrivilege: data.membership.privilege,
    }),
    enabled: !!id,
  });
}

export function useMessages(
  conversationId: string
): ReturnType<typeof useQuery<MessageResponse[], Error>> {
  return useQuery({
    queryKey: chatKeys.messages(conversationId),
    queryFn: () => fetchAllMessages(conversationId),
    enabled: !!conversationId,
  });
}

export function useCreateConversation(): ReturnType<
  typeof useMutation<CreateConversationResponse, Error, CreateConversationRequest>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateConversationRequest): Promise<CreateConversationResponse> => {
      return fetchJson(client.conversations.$post({ json: data }, idempotentHeaders(data)));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
  });
}

// Delete's mutation variable is a bare `conversationId` string — not an object
// the retry-stable `idempotentHeaders` WeakMap can key on. A per-id token
// object gives every retry of one delete the same key; the token is dropped in
// `onSettled` so nothing accumulates.
const deleteKeyTokens = new Map<string, object>();
function deleteConversationHeaders(conversationId: string): ReturnType<typeof idempotentHeaders> {
  let token = deleteKeyTokens.get(conversationId);
  if (token === undefined) {
    token = {};
    deleteKeyTokens.set(conversationId, token);
  }
  return idempotentHeaders(token);
}

export function useDeleteConversation(): ReturnType<
  typeof useMutation<DeleteConversationResponse, Error, string>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string): Promise<DeleteConversationResponse> => {
      return fetchJson(
        client.conversations[':conversationId'].$delete(
          { param: { conversationId } },
          deleteConversationHeaders(conversationId)
        )
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations() });
    },
    onSettled: (_data, _error, conversationId) => {
      deleteKeyTokens.delete(conversationId);
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
    mutationFn: async (variables: {
      conversationId: string;
      data: UpdateConversationRequest;
    }): Promise<UpdateConversationResponse> => {
      return fetchJson(
        client.conversations[':conversationId'].$patch(
          {
            param: { conversationId: variables.conversationId },
            json: variables.data,
          },
          // Key on the original variables reference so retries reuse one key.
          idempotentHeaders(variables)
        )
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
