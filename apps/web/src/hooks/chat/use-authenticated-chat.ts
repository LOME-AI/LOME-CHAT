import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { createFirstEpoch, getPublicKeyFromPrivate, encryptTextForEpoch } from '@hushbox/crypto';
import {
  generateChatTitle,
  toBase64,
  legacyFriendlyErrorMessage,
  ERROR_CODE_CHAT_STREAM_FAILED,
  ROUTES,
  type FundingSource,
  type MemberPrivilege,
} from '@hushbox/shared';
import { useIsMobile } from '@hushbox/ui';
import {
  createUserMessage,
  createAssistantMessage,
  appendTokenToMessage,
} from '@/lib/chat-messages';
import { processStartEvent } from '@/lib/multi-model-stream';
import {
  buildMessagesForRegeneration,
  inferRegenerateModality,
  resolveRegenerateModels,
} from '@/lib/chat-regeneration';
import {
  computeRenderState,
  computePruneIds,
  mergeMessages,
  buildModalityConfigPayload,
  requestedMediaAspectRatio,
  pendingMediaInFlight,
  extractDoneMediaItems,
  resolveUserContent,
  computeDisplayTitle,
  resolveQueryId,
  resolveCallerId,
  checkDecryptionPending,
  computeInputDisabled,
  deriveMessagesReady,
  type RenderState,
  type RegenerateAction,
} from '@/lib/chat/auth-chat-helpers';
import { useChatPageState } from '@/hooks/chat/use-chat-page';
import {
  useChatStream,
  BalanceReservedError,
  BillingMismatchError,
  ContextCapacityError,
  type RegenerateStreamRequest,
  type ModelResult,
} from '@/hooks/chat/use-chat-stream';
import { useOptimisticMessages } from '@/hooks/chat/use-optimistic-messages';
import { useConversation, useMessages, useCreateConversation, chatKeys } from '@/hooks/chat/chat';

import { usePendingChatStore } from '@/stores/pending-chat';
import { useModelStore, getPrimaryModel } from '@/stores/model';
import { useWebSearch } from '@/hooks/chat/use-web-search';
import { useChatErrorStore, createChatError, MAIN_FORK_KEY } from '@/stores/chat-error';
import { billingKeys } from '@/hooks/billing/billing';
import {
  setEpochKey,
  subscribe as epochCacheSubscribe,
  getSnapshot as epochCacheSnapshot,
} from '@/lib/epoch-key-cache';
import { useAuthStore } from '@/lib/auth';
import { useStreamingActivityStore } from '@/stores/streaming-activity';
import { useDecryptedMessages } from '@/hooks/crypto/use-decrypted-messages';
import { useForks } from '@/hooks/chat/forks';
import { useForkMessages } from '@/hooks/chat/use-fork-messages';
import { client, fetchJson } from '@/lib/api-client';
import type { Message, MessageMediaItem } from '@/lib/api';
import type { StageErrorPayload, StageStartPayload } from '@hushbox/shared';
import type {
  DoneEventData,
  ModelMediaProgressData,
  ModelMediaStartData,
  StageDoneEventData,
  StartEventData,
} from '@/lib/sse-client';
import type { PromptInputRef } from '@/components/chat/message/types';

interface UseAuthenticatedChatInput {
  readonly routeConversationId: string;
  readonly activeForkId?: string | null | undefined;
  readonly privateKeyOverride?: Uint8Array | null | undefined;
}

interface UseAuthenticatedChatResult {
  readonly state: ReturnType<typeof useChatPageState>;
  readonly renderState: RenderState;
  readonly messages: Message[];
  readonly messagesReady: boolean;
  readonly historyCharacters: number;
  readonly displayTitle: string | undefined;
  readonly inputDisabled: boolean;
  readonly isStreaming: boolean;
  readonly handleSend: (fundingSource: FundingSource) => void;
  readonly handleSendUserOnly: () => void;
  readonly handleRegenerate: (
    targetMessageId: string,
    action: RegenerateAction,
    editedContent?: string,
    replaceAssistantId?: string
  ) => void;
  readonly promptInputRef: React.RefObject<PromptInputRef | null>;
  readonly errorMessageId: string | undefined;
  readonly realConversationId: string | null;
  readonly callerId: string | undefined;
  readonly callerPrivilege: MemberPrivilege | undefined;
}

function attachCostToMessage(
  setter: React.Dispatch<React.SetStateAction<Message[]>>,
  messageId: string,
  cost: string
): void {
  setter((previous) => previous.map((m) => (m.id === messageId ? { ...m, cost } : m)));
}

function navigateIfActive(
  activeRef: React.RefObject<boolean>,
  navigate: ReturnType<typeof useNavigate>,
  route: string,
  options?: { params?: Record<string, string>; state?: { fromCreate?: boolean } }
): void {
  if (activeRef.current) {
    const { params, state } = options ?? {};
    void navigate({
      to: route,
      ...(params && { params }),
      ...(params && { replace: true }),
      ...(state && { state }),
    });
  }
}

/**
 * Navigate from the `/chat/new` create flow to the real conversation once it
 * exists. The `fromCreate` history marker tells the chat route to hold its React
 * key stable across this hop so the just-created conversation is not remounted —
 * which would drop optimistic-only state (e.g. failed-model error tiles that
 * have no DB row). See resolveChatPageKey.
 */
function navigateToCreatedConversation(
  activeRef: React.RefObject<boolean>,
  navigate: ReturnType<typeof useNavigate>,
  realId: string
): void {
  navigateIfActive(activeRef, navigate, ROUTES.CHAT_ID, {
    params: { id: realId },
    state: { fromCreate: true },
  });
}

interface ApplyPruneInput {
  allMsgs: Message[];
  targetMessageId: string;
  action: RegenerateAction;
  replaceAssistantId: string | undefined;
  conversationId: string;
  setRetryPrunedIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  setLocalMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  queryClient: ReturnType<typeof useQueryClient>;
}

interface AddEditedUserOptimisticInput {
  allMsgs: Message[];
  targetMessageId: string;
  userMessageId: string;
  userContent: string;
  conversationId: string;
  callerId: string | undefined;
  addOptimisticMessage: (message: Message) => void;
}

/**
 * Surface the edit's replacement user message in the same React commit as the
 * prune that removed the original. Without this, the edited text only appears
 * after the post-stream `invalidateQueries` refetch — a multi-second gap
 * during which the chat shows neither the old nor the new user message.
 *
 * Parent is the message preceding the edited target, mirroring the backend's
 * tree placement after edit.
 */
function addEditedUserOptimistic(input: AddEditedUserOptimisticInput): void {
  const targetIndex = input.allMsgs.findIndex((m) => m.id === input.targetMessageId);
  const parentMessageId = targetIndex > 0 ? (input.allMsgs[targetIndex - 1]?.id ?? null) : null;
  input.addOptimisticMessage({
    id: input.userMessageId,
    conversationId: input.conversationId,
    role: 'user',
    content: input.userContent,
    createdAt: new Date().toISOString(),
    ...(input.callerId !== undefined && { senderId: input.callerId }),
    parentMessageId,
  });
}

/**
 * Optimistic prune for retry, edit, and regenerate-one. Applied at the top of
 * the message pipeline AND to the query cache so the stale rows disappear in
 * the same React commit, avoiding a flash of the about-to-be-replaced tiles.
 *
 * The prune scope differs by action — see {@link computePruneIds}.
 */
function applyPrune(input: ApplyPruneInput): void {
  const {
    allMsgs,
    targetMessageId,
    action,
    replaceAssistantId,
    conversationId,
    setRetryPrunedIds,
    setLocalMessages,
    queryClient,
  } = input;

  const idsToRemove = computePruneIds(allMsgs, targetMessageId, action, replaceAssistantId);
  if (idsToRemove.size === 0) return;

  setRetryPrunedIds(idsToRemove);
  queryClient.setQueryData<import('@/lib/api').ConversationResponse>(
    chatKeys.conversation(conversationId),
    (old) => (old ? { ...old, messages: old.messages.filter((m) => !idsToRemove.has(m.id)) } : old)
  );
  setLocalMessages((previous) => previous.filter((m) => !idsToRemove.has(m.id)));
}

function startStreamingIfNeeded(
  assistantMessageIds: string[],
  state: { startStreaming: (ids: string[]) => void }
): void {
  if (assistantMessageIds.length > 0) {
    state.startStreaming(assistantMessageIds);
  }
}

function attachCostsToMessages(
  models: ModelResult[],
  setter: React.Dispatch<React.SetStateAction<Message[]>>
): void {
  for (const mr of models) {
    const code = mr.errorCode;
    if (code) {
      setter((previous) =>
        previous.map((m) =>
          m.id === mr.assistantMessageId ? { ...m, errorCode: code, content: '' } : m
        )
      );
    } else if (mr.cost && mr.cost !== '0') {
      attachCostToMessage(setter, mr.assistantMessageId, mr.cost);
    }
  }
}

interface PatchMessageWithMediaParams {
  setter: React.Dispatch<React.SetStateAction<Message[]>>;
  assistantMessageId: string;
  mediaItems: MessageMediaItem[];
  wrappedContentKey: string;
  epochNumber: number;
}

function patchMessageWithMedia({
  setter,
  assistantMessageId,
  mediaItems,
  wrappedContentKey,
  epochNumber,
}: PatchMessageWithMediaParams): void {
  setter((previous) =>
    previous.map(
      (m): Message =>
        m.id === assistantMessageId ? { ...m, mediaItems, wrappedContentKey, epochNumber } : m
    )
  );
}

/**
 * Patches media content items + wrappedContentKey onto local assistant
 * messages using the SSE `done` event payload, so image/video/audio appear
 * immediately without waiting for a query refetch.
 */
function attachMediaItemsFromDoneEvent(
  doneData: DoneEventData | undefined,
  epochNumber: number,
  setter: React.Dispatch<React.SetStateAction<Message[]>>
): void {
  if (!doneData?.models) return;
  for (const modelEntry of doneData.models) {
    const mediaItems = extractDoneMediaItems(modelEntry.contentItems);
    if (mediaItems.length === 0) continue;
    patchMessageWithMedia({
      setter,
      assistantMessageId: modelEntry.assistantMessageId,
      mediaItems,
      wrappedContentKey: modelEntry.wrappedContentKey,
      epochNumber,
    });
  }
}

function handleRegenerationError(
  error: unknown,
  failedContent: string,
  forkKey: string,
  promptInputRef: React.RefObject<PromptInputRef | null>
): void {
  if (error instanceof BillingMismatchError || error instanceof BalanceReservedError) {
    useChatErrorStore.getState().setError(
      forkKey,
      createChatError({
        content: legacyFriendlyErrorMessage(error.code),
        retryable: true,
        failedContent,
      })
    );
  } else if (error instanceof ContextCapacityError) {
    useChatErrorStore.getState().setError(
      forkKey,
      createChatError({
        content: legacyFriendlyErrorMessage(error.code),
        retryable: false,
        failedContent,
      })
    );
  } else {
    console.error('Regeneration failed:', error);
    useChatErrorStore.getState().setError(
      forkKey,
      createChatError({
        content: legacyFriendlyErrorMessage(ERROR_CODE_CHAT_STREAM_FAILED),
        retryable: false,
        failedContent,
      })
    );
    promptInputRef.current?.focus();
  }
}

export function useAuthenticatedChat({
  routeConversationId,
  activeForkId,
  privateKeyOverride,
}: UseAuthenticatedChatInput): UseAuthenticatedChatResult {
  const state = useChatPageState();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const creationStartedRef = React.useRef(false);
  // Aborts the in-flight stream's fetch on unmount. The chat subtree is keyed by
  // conversation id, so switching conversations unmounts this hook and fires the
  // abort below — stopping the server from billing an abandoned turn. A fresh
  // controller is installed per turn; only the latest is aborted on unmount.
  const streamAbortRef = React.useRef<AbortController | null>(null);
  const activeRef = React.useRef(true);
  React.useEffect(() => {
    activeRef.current = routeConversationId === 'new';
    return () => {
      activeRef.current = false;
    };
  }, [routeConversationId]);

  const isCreateMode = routeConversationId === 'new';

  const pendingMessage = usePendingChatStore((s) => s.pendingMessage);
  const pendingFundingSource = usePendingChatStore((s) => s.pendingFundingSource);
  const clearPendingMessage = usePendingChatStore((s) => s.clearPendingMessage);

  const [realConversationId, setRealConversationId] = React.useState<string | null>(
    isCreateMode ? null : routeConversationId
  );
  const [localMessages, setLocalMessages] = React.useState<Message[]>([]);
  const [localTitle, setLocalTitle] = React.useState<string | null>(null);
  const [retryPrunedIds, setRetryPrunedIds] = React.useState<ReadonlySet<string>>(new Set());

  const {
    optimisticMessages,
    addOptimisticMessage,
    removeOptimisticMessage,
    updateOptimisticMessageContent,
    setOptimisticMessageError,
    setOptimisticMessageStageStart,
    setOptimisticMessageStageDone,
    setOptimisticMessageStageError,
    setOptimisticMessageMediaStart,
    setOptimisticMessageMediaProgress,
  } = useOptimisticMessages();

  const activeModality = useModelStore((state) => state.activeModality);
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const imageConfig = useModelStore((state) => state.imageConfig);
  const videoConfig = useModelStore((state) => state.videoConfig);
  const audioConfig = useModelStore((state) => state.audioConfig);
  // Single source of truth for web-search state (see useWebSearch). In the
  // authenticated chat `active === preferred`, so this is behavior-preserving.
  const { active: webSearchEnabled } = useWebSearch();
  const { isStreaming, startStream, startRegenerateStream } = useChatStream('authenticated');
  // Scope the error subscription to the currently-active fork (or 'main' for
  // linear / no-fork conversations). Switching forks reads a different slot,
  // so an error that occurred on Main no longer leaks onto Fork 1's view.
  const errorForkKey = activeForkId ?? MAIN_FORK_KEY;
  const chatError = useChatErrorStore((s) => s.errorsByFork[errorForkKey] ?? null);
  const createConversation = useCreateConversation();
  const createConversationRef = React.useRef(createConversation.mutateAsync);
  React.useEffect(() => {
    createConversationRef.current = createConversation.mutateAsync;
  });
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const authUserId = useAuthStore((s) => s.user?.id);
  const customInstructions = useAuthStore((s) => s.customInstructions);

  const queryId = resolveQueryId(realConversationId);
  const conversationQuery = useConversation(queryId);
  const conversation = conversationQuery.data;
  const isConversationLoading = conversationQuery.isLoading;

  const callerId = resolveCallerId(conversation?.callerId, authUserId);
  const { data: apiMessages, isLoading: isMessagesLoading } = useMessages(queryId);
  const decryptedApiMessages = useDecryptedMessages(
    realConversationId,
    apiMessages,
    privateKeyOverride
  );
  const { data: forks } = useForks(queryId);

  const forkFilteredDecrypted = useForkMessages(
    decryptedApiMessages,
    forks ?? [],
    activeForkId ?? null
  );

  const localMessagesRef = React.useRef<Message[]>([]);
  React.useEffect(() => {
    localMessagesRef.current = localMessages;
  }, [localMessages]);

  const conversationIdRef = React.useRef<string>('');

  React.useEffect(() => {
    return () => {
      useChatErrorStore.getState().clearAll();
      streamAbortRef.current?.abort();
    };
  }, []);

  const modelMessageMapRef = React.useRef(new Map<string, string>());

  const handleStreamStart = React.useCallback(
    (data: StartEventData) => {
      const { modelMap, messages, assistantMessageIds } = processStartEvent(
        data,
        conversationIdRef.current,
        data.userMessageId
      );
      modelMessageMapRef.current = modelMap;
      // First message of a new conversation: stamp the media backdrop hint at
      // creation, the same as the optimistic flow, so it shows the animation
      // from the first frame instead of the text "is generating…" indicator.
      const mediaInFlight = pendingMediaInFlight(activeModality, imageConfig, videoConfig);
      const stamped = mediaInFlight ? messages.map((m) => ({ ...m, mediaInFlight })) : messages;
      setLocalMessages((previous) => [...previous, ...stamped]);
      startStreamingIfNeeded(assistantMessageIds, state);
    },
    [state, activeModality, imageConfig, videoConfig]
  );

  const handleStreamToken = React.useCallback((token: string, modelId: string) => {
    const msgId = modelMessageMapRef.current.get(modelId);
    if (msgId) {
      setLocalMessages((previous) => appendTokenToMessage(previous, msgId, token));
    }
  }, []);

  const handleStreamModelError = React.useCallback((data: { modelId: string; code?: string }) => {
    const msgId = modelMessageMapRef.current.get(data.modelId);
    if (msgId) {
      setLocalMessages((previous) =>
        previous.map((m) =>
          m.id === msgId ? { ...m, errorCode: data.code ?? 'STREAM_ERROR', content: '' } : m
        )
      );
    }
  }, []);

  /**
   * Stage events fire on the new-chat flow when a model has pre-inference
   * stages (e.g. Smart Model's classifier). Without these handlers the
   * classifier `stage:start` reaches the SSE parser but never updates UI
   * state — the "Choosing the best model…" indicator stays hidden until
   * `stage:done` arrives, by which point inference is already streaming.
   * The handlers mutate `localMessages` (not optimistic) because the
   * new-chat flow renders from `localMessages` during create-mode.
   */
  const handleStreamStageStart = React.useCallback(
    (data: StageStartPayload) => {
      setLocalMessages((previous) =>
        previous.map((m) =>
          m.id === data.assistantMessageId ? { ...m, classifyingStageId: data.stageId } : m
        )
      );
      state.startStreaming([data.assistantMessageId]);
    },
    [state]
  );

  const handleStreamStageDone = React.useCallback((data: StageDoneEventData) => {
    setLocalMessages((previous) =>
      previous.map((m) => {
        if (m.id !== data.assistantMessageId) return m;
        const next: Message = {
          ...m,
          classifyingStageId: undefined,
          modelName: data.payload.resolvedModelId,
          resolvedModelName: data.payload.resolvedModelName,
        };
        if ((data.payload.stageId as string) === 'smart-model') {
          next.isSmartModel = true;
        }
        return next;
      })
    );
  }, []);

  const handleStreamStageError = React.useCallback(
    (data: StageErrorPayload) => {
      setLocalMessages((previous) =>
        previous.map((m) =>
          m.id === data.assistantMessageId
            ? { ...m, classifyingStageId: undefined, errorCode: data.errorCode, content: '' }
            : m
        )
      );
      state.stopStreaming([data.assistantMessageId]);
    },
    [state]
  );

  // Media handlers for the new-chat flow (mutate localMessages, mirroring the
  // optimistic setters). `model:media:start` refines the creation-time mime;
  // `model:media:progress` drives the first-message video progress sweep.
  const handleStreamMediaStart = React.useCallback(
    (data: ModelMediaStartData) => {
      const aspectRatio = requestedMediaAspectRatio(data.mediaType, imageConfig, videoConfig);
      setLocalMessages((previous) =>
        previous.map((m) =>
          m.id === data.assistantMessageId
            ? {
                ...m,
                mediaInFlight: {
                  mediaType: data.mediaType,
                  mimeType: data.mimeType,
                  ...(aspectRatio !== undefined && { aspectRatio }),
                },
              }
            : m
        )
      );
    },
    [imageConfig, videoConfig]
  );

  const handleStreamMediaProgress = React.useCallback((data: ModelMediaProgressData) => {
    setLocalMessages((previous) =>
      previous.map((m) =>
        m.id === data.assistantMessageId ? { ...m, mediaProgress: { percent: data.percent } } : m
      )
    );
  }, []);

  // Routes onToken/onModelError to the right optimistic message for the active
  // turn (modelId → assistantMessageId). Replaced wholesale on each onStart and
  // intentionally not scoped per-turn: a newer turn only starts after the prior
  // turn's last model:done, so no two turns emit tokens at once and stale
  // entries between turns are never read.
  const optimisticModelMapRef = React.useRef(new Map<string, string>());

  const createOptimisticStreamCallbacks = React.useCallback(
    (convId: string) => {
      // The assistant tile ids this turn owns. Captured in onStart so the
      // completion callbacks release ONLY this turn's tracking — a turn that
      // settles while a newer overlapping turn is mid-flight must never clear
      // the newer turn's streaming/persisting ids.
      let turnAssistantIds: string[] = [];
      return {
        onStart: (data: StartEventData) => {
          const { modelMap, messages, assistantMessageIds } = processStartEvent(
            data,
            convId,
            data.userMessageId
          );
          optimisticModelMapRef.current = modelMap;
          turnAssistantIds = assistantMessageIds;
          // Stamp the media backdrop hint from the first frame so a media turn
          // never flashes the text "thinking" indicator before model:media:start.
          const mediaInFlight = pendingMediaInFlight(activeModality, imageConfig, videoConfig);
          for (const msg of messages) {
            addOptimisticMessage(mediaInFlight ? { ...msg, mediaInFlight } : msg);
          }
          startStreamingIfNeeded(assistantMessageIds, state);
        },
        onToken: (token: string, modelId: string) => {
          const msgId = optimisticModelMapRef.current.get(modelId);
          if (msgId) {
            updateOptimisticMessageContent(msgId, token);
          }
        },
        onModelError: (data: { modelId: string; code?: string }) => {
          const msgId = optimisticModelMapRef.current.get(data.modelId);
          if (msgId) {
            setOptimisticMessageError(msgId, data.code ?? 'STREAM_ERROR');
          }
        },
        // `model:media:start` fires twice per media model: once pre-gateway with
        // a placeholder mime, once post-gateway with the real mime. Both calls
        // overwrite `mediaInFlight` so the placeholder progresses from
        // "Generating image…" with placeholder mime to a precise mime ahead of
        // the bytes landing. The requested aspect ratio is stamped alongside so
        // the placeholder reserves the media's true shape, not a square.
        onModelMediaStart: (data: ModelMediaStartData) => {
          const aspectRatio = requestedMediaAspectRatio(data.mediaType, imageConfig, videoConfig);
          setOptimisticMessageMediaStart(
            data.assistantMessageId,
            data.mediaType,
            data.mimeType,
            aspectRatio
          );
        },
        onModelMediaProgress: (data: ModelMediaProgressData) => {
          setOptimisticMessageMediaProgress(data.assistantMessageId, data.percent);
        },
        onStageStart: (data: StageStartPayload) => {
          setOptimisticMessageStageStart(data.assistantMessageId, data.stageId);
        },
        onStageDone: (data: StageDoneEventData) => {
          setOptimisticMessageStageDone(data.assistantMessageId, data.payload);
        },
        onStageError: (data: StageErrorPayload) => {
          setOptimisticMessageStageError(data.assistantMessageId, data.errorCode);
        },
        // Token streaming has ended for every model in this turn. The server is
        // still settling cost / persistence and the SSE `done` event hasn't
        // arrived yet, but the user has seen all the tokens — re-enable the
        // input and let `resolveMessageActions` show the toolbar now rather
        // than several seconds later. Fixes the "long awkward delay" UX bug.
        onAllModelsComplete: () => {
          state.stopStreaming(turnAssistantIds);
        },
        // SSE `done` event — saveChatTurn has committed. Clear the persistence-
        // tracking set so the next send doesn't race against an in-flight commit
        // and resolve the wrong parentMessageId. Distinct from stopStreaming
        // (early-flip, UX) so the toolbar/input stay responsive while tests
        // gate on data-streaming-count for actual persistence.
        onAllStreamsSettled: () => {
          state.stopPersisting(turnAssistantIds);
        },
      };
    },
    [
      state,
      addOptimisticMessage,
      updateOptimisticMessageContent,
      setOptimisticMessageError,
      setOptimisticMessageMediaStart,
      setOptimisticMessageMediaProgress,
      setOptimisticMessageStageStart,
      setOptimisticMessageStageDone,
      setOptimisticMessageStageError,
      activeModality,
      imageConfig,
      videoConfig,
    ]
  );

  interface ExecuteStreamParams {
    convId: string;
    userMessageData: { id: string; content: string };
    messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[];
    fundingSource: FundingSource;
    forkId?: string;
    /** Receives this turn's assistant tile ids when `start` arrives, so the
     * caller can scope its own error cleanup to the tiles it created. */
    onPlaceholders: (assistantMessageIds: string[]) => void;
  }

  const executeStream = React.useCallback(
    async (params: ExecuteStreamParams): Promise<{ models: ModelResult[] }> => {
      const { convId, userMessageData, messagesForInference, fundingSource, forkId } = params;
      const callbacks = createOptimisticStreamCallbacks(convId);
      const abortController = new AbortController();
      streamAbortRef.current = abortController;
      const { models, doneData } = await startStream(
        {
          conversationId: convId,
          modality: activeModality,
          models: selectedModels.map((m) => m.id),
          userMessage: userMessageData,
          messagesForInference,
          fundingSource,
          webSearchEnabled,
          ...(customInstructions != null && { customInstructions }),
          ...(forkId != null && { forkId }),
          ...buildModalityConfigPayload(activeModality, imageConfig, videoConfig, audioConfig),
        },
        {
          ...callbacks,
          signal: abortController.signal,
          onStart: (data: StartEventData) => {
            callbacks.onStart(data);
            params.onPlaceholders(data.models.map((m) => m.assistantMessageId));
          },
        }
      );
      if (doneData?.epochNumber !== undefined) {
        attachMediaItemsFromDoneEvent(doneData, doneData.epochNumber, setLocalMessages);
      }
      await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(convId) });
      void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
      useStreamingActivityStore.getState().endStream();

      return { models };
    },
    [
      createOptimisticStreamCallbacks,
      startStream,
      selectedModels,
      webSearchEnabled,
      customInstructions,
      state,
      queryClient,
      activeModality,
      imageConfig,
      videoConfig,
      audioConfig,
    ]
  );

  React.useEffect(() => {
    if (!isCreateMode || !pendingMessage || creationStartedRef.current || !accountPrivateKey) {
      return;
    }
    creationStartedRef.current = true;

    const conversationId = crypto.randomUUID();
    conversationIdRef.current = conversationId;

    const userMessage = createUserMessage(conversationId, pendingMessage, callerId, null);
    setLocalMessages([userMessage]);

    const createConversationAndStream = async (): Promise<void> => {
      try {
        const accountPublicKey = getPublicKeyFromPrivate(accountPrivateKey);
        const epoch = createFirstEpoch([accountPublicKey]);
        const ownerWrap = epoch.memberWraps[0];
        if (!ownerWrap) throw new Error('createFirstEpoch returned no member wraps');

        const titleText = generateChatTitle(pendingMessage);
        const encryptedTitleBytes = encryptTextForEpoch(epoch.epochPublicKey, titleText);

        const response = await createConversationRef.current({
          id: conversationId,
          title: toBase64(encryptedTitleBytes),
          epochPublicKey: toBase64(epoch.epochPublicKey),
          confirmationHash: toBase64(epoch.confirmationHash),
          memberWrap: toBase64(ownerWrap.wrap),
        });

        const realId = response.conversation.id;

        if (!response.isNew) {
          // Idempotent: conversation existed — full response available, seed cache
          // eslint-disable-next-line sonarjs/no-unused-vars -- rest-spread requires naming the omitted key
          const { isNew: _isNew, ...fullData } = response;
          queryClient.setQueryData(chatKeys.conversation(realId), fullData);
          clearPendingMessage();
          setRealConversationId(realId);
          navigateToCreatedConversation(activeRef, navigate, realId);
          return;
        }

        setEpochKey(realId, 1, epoch.epochPrivateKey);

        const realUserMessage = createUserMessage(realId, pendingMessage, callerId, null);
        setLocalMessages([realUserMessage]);
        setLocalTitle(titleText);
        clearPendingMessage();
        setRealConversationId(realId);

        // Navigate to the real conversation as soon as its row exists, before
        // the stream settles — otherwise a slow stream parks the page at
        // /chat/new. Seed the conversation cache first so chrome (title,
        // members) is populated and the early route flip doesn't flash; local
        // (optimistic) messages bridge the message list until the post-stream
        // refetch lands (computeRenderState keeps showing them through the
        // decrypt). The component key holds across this hop (fromCreate) and
        // creationStartedRef stops the create effect from re-firing when
        // isCreateMode flips false.
        queryClient.setQueryData(chatKeys.conversation(realId), {
          conversation: response.conversation,
          messages: [],
          forks: [],
          accepted: true,
          invitedByUsername: null,
          callerId: callerId ?? '',
          privilege: 'owner',
        });
        navigateToCreatedConversation(activeRef, navigate, realId);

        await executeStreamAndFinalize(
          realId,
          pendingMessage,
          response.conversation,
          pendingFundingSource ?? 'personal_balance'
        );
      } catch (error: unknown) {
        console.error('createConversationAndStream failed:', error);
        navigateIfActive(activeRef, navigate, ROUTES.CHAT);
      }
    };

    const executeStreamAndFinalize = async (
      realId: string,
      message: string,
      conversationObject: import('@/lib/api').Conversation,
      fundingSource: FundingSource
    ): Promise<void> => {
      const userMsgId = crypto.randomUUID();
      // Assistant tile ids for this first turn, captured from `start`. Scopes
      // the explicit stop calls below so they release only this turn — a second
      // send during the create→navigate window keeps its own tracking.
      const newChatAssistantIds: string[] = [];
      const abortController = new AbortController();
      streamAbortRef.current = abortController;
      try {
        const streamResult = await startStream(
          {
            conversationId: realId,
            modality: activeModality,
            models: selectedModels.map((m) => m.id),
            userMessage: { id: userMsgId, content: message },
            messagesForInference: [{ role: 'user', content: message }],
            fundingSource,
            webSearchEnabled,
            ...(customInstructions != null && { customInstructions }),
            ...buildModalityConfigPayload(activeModality, imageConfig, videoConfig, audioConfig),
          },
          {
            signal: abortController.signal,
            onStart: (data: StartEventData) => {
              handleStreamStart(data);
              // for-loop, not .map: a nested arrow here would exceed the
              // function-nesting depth lint rule at this call site.
              for (const m of data.models) newChatAssistantIds.push(m.assistantMessageId);
            },
            onToken: handleStreamToken,
            onModelError: handleStreamModelError,
            onModelMediaStart: handleStreamMediaStart,
            onModelMediaProgress: handleStreamMediaProgress,
            onStageStart: handleStreamStageStart,
            onStageDone: handleStreamStageDone,
            onStageError: handleStreamStageError,
          }
        );

        attachCostsToMessages(streamResult.models, setLocalMessages);
        if (streamResult.doneData?.epochNumber !== undefined) {
          attachMediaItemsFromDoneEvent(
            streamResult.doneData,
            streamResult.doneData.epochNumber,
            setLocalMessages
          );
        }

        // Preserve errored model messages as optimistic so they survive the
        // localMessages → API messages mode transition after navigation.
        // Failed models have no DB row, so they'd disappear without this.
        for (const mr of streamResult.models) {
          if (mr.errorCode) {
            const errorMsg = createAssistantMessage(
              realId,
              mr.assistantMessageId,
              mr.modelId,
              userMsgId
            );
            addOptimisticMessage({ ...errorMsg, errorCode: mr.errorCode, content: '' });
          }
        }

        // Seed cache with full response shape so useConversation sees data immediately
        queryClient.setQueryData(chatKeys.conversation(realId), {
          conversation: conversationObject,
          messages: [],
          forks: [],
          accepted: true,
          invitedByUsername: null,
          callerId: callerId ?? '',
          privilege: 'owner',
        });
        await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(realId) });
        void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

        // This call site uses hand-written callbacks instead of
        // createOptimisticStreamCallbacks, so the wrapper has no caller-provided
        // onAllStreamsSettled to fire. Persistence cleanup is explicit here.
        state.stopStreaming(newChatAssistantIds);
        state.stopPersisting(newChatAssistantIds);
        useStreamingActivityStore.getState().endStream();
      } catch (streamError: unknown) {
        console.error('Stream failed:', streamError);
        state.stopStreaming(newChatAssistantIds);
        state.stopPersisting(newChatAssistantIds);
        useStreamingActivityStore.getState().endStream();
        // New-chat flow has no fork yet — error belongs on the main slot.
        useChatErrorStore.getState().setError(
          MAIN_FORK_KEY,
          createChatError({
            content: legacyFriendlyErrorMessage(ERROR_CODE_CHAT_STREAM_FAILED),
            retryable: false,
            failedContent: message,
          })
        );
      }
    };

    void createConversationAndStream();
  }, [
    isCreateMode,
    pendingMessage,
    pendingFundingSource,
    accountPrivateKey,
    clearPendingMessage,
    handleStreamStart,
    handleStreamToken,
    handleStreamModelError,
    handleStreamStageStart,
    handleStreamStageDone,
    handleStreamStageError,
    selectedModels,
    webSearchEnabled,
    customInstructions,
    startStream,
    queryClient,
    navigate,
    state,
  ]);

  /** Validate input, clear it, refocus, and return trimmed content + conversationId (or null). */
  const prepareMessageInput = React.useCallback((): {
    content: string;
    convId: string;
  } | null => {
    const content = state.inputValue.trim();
    if (!content || !realConversationId) {
      return null;
    }

    // User typed a new message on the active fork — clear that fork's
    // previous error tile (if any) before sending.
    useChatErrorStore.getState().clearError(errorForkKey);

    state.clearInput();
    if (!isMobile) {
      promptInputRef.current?.focus();
    }

    return { content, convId: realConversationId };
  }, [state, realConversationId, errorForkKey, isMobile, promptInputRef]);

  const handleSend = React.useCallback(
    (fundingSource: FundingSource) => {
      const prepared = prepareMessageInput();
      if (!prepared) {
        return;
      }
      const { content, convId } = prepared;

      const userMessageId = crypto.randomUUID();

      // Resolve parent: last message in the current view (fork-filtered + optimistic)
      const allCurrentMessages = [...forkFilteredDecrypted, ...optimisticMessages];
      const lastMessage = allCurrentMessages.at(-1);
      const optimisticUserMessage = createUserMessage(
        convId,
        content,
        callerId,
        lastMessage?.id ?? null
      );
      addOptimisticMessage(optimisticUserMessage);

      // Build messagesForInference from fork-filtered decrypted messages + new user message
      const messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
        ...forkFilteredDecrypted.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        ...optimisticMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        { role: 'user' as const, content },
      ];

      // This turn's assistant tile ids, captured from the `start` event. Scoped
      // locally (not via a shared ref) so an overlapping send can't make this
      // turn's error cleanup remove the other turn's tiles.
      const placeholderIds: string[] = [];

      void (async () => {
        try {
          const { models: modelResults } = await executeStream({
            convId,
            userMessageData: {
              id: userMessageId,
              content,
            },
            messagesForInference,
            fundingSource,
            onPlaceholders: (ids) => placeholderIds.push(...ids),
            ...(activeForkId != null && { forkId: activeForkId }),
          });
          removeOptimisticMessage(optimisticUserMessage.id);
          for (const mr of modelResults) {
            // Keep optimistic messages with errorCode — they have no DB row to replace them
            if (!mr.errorCode) {
              removeOptimisticMessage(mr.assistantMessageId);
            }
          }
        } catch (error: unknown) {
          if (error instanceof BillingMismatchError) {
            await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
          }
          handleRegenerationError(error, content, errorForkKey, promptInputRef);

          // Stream threw after `start` fired: drop the AI placeholders that
          // `onStart` added optimistically. Without this, each placeholder
          // renders as an invisible empty bubble whose action toolbar floats
          // above the chat-error tile.
          for (const placeholderId of placeholderIds) {
            removeOptimisticMessage(placeholderId);
          }

          removeOptimisticMessage(optimisticUserMessage.id);
          state.stopStreaming(placeholderIds);
          useStreamingActivityStore.getState().endStream();
        }
      })();
    },
    [
      prepareMessageInput,
      addOptimisticMessage,
      removeOptimisticMessage,
      executeStream,
      forkFilteredDecrypted,
      optimisticMessages,
      activeForkId,
      errorForkKey,
      state,
      realConversationId,
      promptInputRef,
    ]
  );

  const handleSendUserOnly = React.useCallback(() => {
    const prepared = prepareMessageInput();
    if (!prepared) {
      return;
    }
    const { content, convId } = prepared;

    const messageId = crypto.randomUUID();
    const allCurrentMessages = [...forkFilteredDecrypted, ...optimisticMessages];
    const lastMsg = allCurrentMessages.at(-1);
    const optimisticUserMessage = createUserMessage(convId, content, callerId, lastMsg?.id ?? null);
    addOptimisticMessage(optimisticUserMessage);

    void (async () => {
      try {
        await fetchJson(
          client.api.chat[':conversationId'].message.$post({
            param: { conversationId: convId },
            json: {
              messageId,
              content,
            },
          })
        );
        await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(convId) });
        removeOptimisticMessage(optimisticUserMessage.id);
      } catch (error: unknown) {
        console.error('User-only message failed:', error);
        removeOptimisticMessage(optimisticUserMessage.id);
        promptInputRef.current?.focus();
      }
    })();
  }, [
    prepareMessageInput,
    addOptimisticMessage,
    removeOptimisticMessage,
    queryClient,
    forkFilteredDecrypted,
    optimisticMessages,
    state,
    realConversationId,
  ]);

  const handleRegenerate = React.useCallback(
    (
      targetMessageId: string,
      action: RegenerateAction,
      editedContent?: string,
      replaceAssistantId?: string
    ) => {
      if (!realConversationId) return;

      const allMsgs = [...forkFilteredDecrypted, ...optimisticMessages];

      // null when the anchor's decrypted content isn't ready (a refetch is
      // re-decrypting). Bail before any state mutation rather than POST empty
      // content, which the server rejects (min(1)) as a failed turn.
      const userContent = resolveUserContent(action, editedContent, allMsgs, targetMessageId);
      if (userContent === null) return;

      // Regenerating on this fork — clear any prior error tile for this fork
      // before kicking off the new request.
      useChatErrorStore.getState().clearError(errorForkKey);

      // Build messagesForInference from fork-filtered decrypted messages up to the target
      const messagesForInference = buildMessagesForRegeneration(
        allMsgs,
        targetMessageId,
        action,
        editedContent
      );

      const userMessageId = crypto.randomUUID();

      applyPrune({
        allMsgs,
        targetMessageId,
        action,
        replaceAssistantId,
        conversationId: realConversationId,
        setRetryPrunedIds,
        setLocalMessages,
        queryClient,
      });

      if (action === 'edit') {
        addEditedUserOptimistic({
          allMsgs,
          targetMessageId,
          userMessageId,
          userContent,
          conversationId: realConversationId,
          callerId,
          addOptimisticMessage,
        });
      }

      const modality = inferRegenerateModality(targetMessageId, allMsgs);
      const models = resolveRegenerateModels(
        allMsgs,
        targetMessageId,
        replaceAssistantId,
        getPrimaryModel(selectedModels).id
      );

      const request: RegenerateStreamRequest = {
        conversationId: realConversationId,
        targetMessageId,
        action,
        modality,
        models,
        ...(replaceAssistantId !== undefined && { replaceAssistantId }),
        userMessage: { id: userMessageId, content: userContent },
        messagesForInference,
        fundingSource: 'personal_balance',
        ...(activeForkId != null && { forkId: activeForkId }),
        ...(webSearchEnabled && { webSearchEnabled }),
        ...(customInstructions != null && { customInstructions }),
        ...buildModalityConfigPayload(modality, imageConfig, videoConfig, audioConfig),
      };

      // Adopt the multi-model send's optimistic callback set. Single-model
      // regenerate is structurally a special case of N=1, so it reuses the
      // same per-modelId routing without divergent code paths.
      const callbacks = createOptimisticStreamCallbacks(realConversationId);
      const abortController = new AbortController();
      streamAbortRef.current = abortController;
      // Populated synchronously inside onStart (which fires during the await
      // below, before stream completion). Safe to read post-await — the
      // stream resolves strictly after onStart, so the array is fully
      // populated by then.
      const placeholderIds: string[] = [];

      void (async () => {
        try {
          await startRegenerateStream(request, {
            ...callbacks,
            signal: abortController.signal,
            onStart: (data) => {
              callbacks.onStart(data);
              for (const m of data.models) placeholderIds.push(m.assistantMessageId);
            },
          });

          state.stopStreaming(placeholderIds);

          await queryClient.invalidateQueries({
            queryKey: chatKeys.conversation(realConversationId),
          });
          setRetryPrunedIds(new Set());
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

          for (const id of placeholderIds) removeOptimisticMessage(id);
          if (action === 'edit') removeOptimisticMessage(userMessageId);
          useStreamingActivityStore.getState().endStream();
        } catch (error: unknown) {
          state.stopStreaming(placeholderIds);

          if (error instanceof BillingMismatchError) {
            await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
          }
          handleRegenerationError(error, userContent, errorForkKey, promptInputRef);

          await queryClient.invalidateQueries({
            queryKey: chatKeys.conversation(realConversationId),
          });
          setRetryPrunedIds(new Set());

          for (const id of placeholderIds) removeOptimisticMessage(id);
          if (action === 'edit') removeOptimisticMessage(userMessageId);
          useStreamingActivityStore.getState().endStream();
        }
      })();
    },
    [
      realConversationId,
      activeForkId,
      errorForkKey,
      forkFilteredDecrypted,
      optimisticMessages,
      selectedModels,
      webSearchEnabled,
      customInstructions,
      imageConfig,
      videoConfig,
      audioConfig,
      startRegenerateStream,
      removeOptimisticMessage,
      addOptimisticMessage,
      callerId,
      createOptimisticStreamCallbacks,
      state,
      queryClient,
      promptInputRef,
      setRetryPrunedIds,
      setLocalMessages,
    ]
  );

  const primaryModelId = getPrimaryModel(selectedModels).id;

  const allMessages = React.useMemo(() => {
    const merged = mergeMessages({
      isCreateMode,
      realConversationId,
      localMessages,
      decryptedApiMessages: forkFilteredDecrypted,
      optimisticMessages,
      chatError,
      primaryModelId,
    });
    if (retryPrunedIds.size > 0) {
      return merged.filter((m) => !retryPrunedIds.has(m.id));
    }
    return merged;
  }, [
    isCreateMode,
    realConversationId,
    localMessages,
    forkFilteredDecrypted,
    optimisticMessages,
    chatError,
    primaryModelId,
    retryPrunedIds,
  ]);

  const historyCharacters = React.useMemo(() => {
    return allMessages.reduce((total, message) => total + message.content.length, 0);
  }, [allMessages]);

  const isDecryptionPending = checkDecryptionPending(
    isCreateMode,
    apiMessages?.length ?? 0,
    decryptedApiMessages.length
  );

  const renderState = React.useMemo(
    () =>
      computeRenderState({
        isCreateMode,
        pendingMessage,
        localMessagesLength: localMessages.length,
        conversation,
        isConversationLoading,
        isMessagesLoading,
        isDecryptionPending,
      }),
    [
      isCreateMode,
      pendingMessage,
      localMessages.length,
      conversation,
      isConversationLoading,
      isMessagesLoading,
      isDecryptionPending,
    ]
  );

  React.useEffect(() => {
    if (renderState.type === 'redirecting') {
      void navigate({ to: ROUTES.CHAT });
    }
  }, [renderState.type, navigate]);

  const epochCacheVersion = React.useSyncExternalStore(epochCacheSubscribe, epochCacheSnapshot);

  const displayTitle = React.useMemo(
    () => computeDisplayTitle(localTitle, conversation, realConversationId),
    [conversation, realConversationId, localTitle, epochCacheVersion]
  );
  const callerPrivilege = conversation?.callerPrivilege;
  const inputDisabled = computeInputDisabled(isCreateMode, realConversationId, callerPrivilege);

  const errorMessageId: string | undefined = chatError?.id;

  const messagesReady = deriveMessagesReady(
    isCreateMode,
    isConversationLoading,
    isDecryptionPending
  );

  return {
    state,
    renderState,
    messages: allMessages,
    messagesReady,
    historyCharacters,
    displayTitle,
    inputDisabled,
    isStreaming,
    handleSend,
    handleSendUserOnly,
    handleRegenerate,
    promptInputRef,
    errorMessageId,
    realConversationId,
    callerId,
    callerPrivilege,
  };
}

export { DECRYPTING_TITLE } from '@/hooks/chat/chat';

// Pure helpers live in @/lib/chat/auth-chat-helpers; re-exported here so the
// module's public surface (consumed by tests and existing importers) is
// unchanged after the extraction.
export {
  shouldRedirect,
  computeRenderState,
  computePruneIds,
  mergeMessages,
  requestedMediaAspectRatio,
  pendingMediaInFlight,
  type ComputeRenderStateParams,
} from '@/lib/chat/auth-chat-helpers';
