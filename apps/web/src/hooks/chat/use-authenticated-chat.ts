import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { createFirstEpoch, getPublicKeyFromPrivate, encryptTextForEpoch } from '@hushbox/crypto';
import {
  generateChatTitle,
  toBase64,
  friendlyErrorMessage,
  customUserMessage,
  SMART_MODEL_ID,
  ROUTES,
  type FundingSource,
  type MemberPrivilege,
  type UserFacingMessage,
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
  ChatRequestError,
  ChatRunFailedError,
  type RegenerateStreamRequest,
  type ModelResult,
  type StartEventData,
  type ModelErrorData,
  type ModelMediaStartData,
} from '@/hooks/chat/use-chat-stream';
import { useOptimisticMessages } from '@/hooks/chat/use-optimistic-messages';
import {
  useConversation,
  useMessages,
  useCreateConversation,
  chatKeys,
  type ConversationDetailResponse,
  type ConversationMembership,
} from '@/hooks/chat/chat';

import { usePendingChatStore } from '@/stores/pending-chat';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/message-queue';
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
import type { Message, MessageResponse } from '@/lib/api';

/**
 * Membership seeded into the conversation cache for a just-created
 * conversation: the creator is its owner. Replaced by the authoritative
 * `membership` the next fetch loads.
 */
const OWNER_MEMBERSHIP: ConversationMembership = {
  privilege: 'owner',
  muted: false,
  pinned: false,
  accepted: true,
  visibleFromEpoch: 1,
};

/** Stable empty reference so an unqueued conversation never re-renders consumers. */
const EMPTY_QUEUE: QueuedMessage[] = [];

/**
 * Funding source for auto-drained queued messages. The composer's per-keystroke
 * budget resolution isn't available at drain time, so drained sends default to
 * the personal balance — the same default the create flow uses.
 */
const DRAIN_FUNDING_SOURCE: FundingSource = 'personal_balance';
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
  readonly handleStop: () => void;
  readonly promptInputRef: React.RefObject<PromptInputRef | null>;
  readonly errorMessageId: string | undefined;
  readonly realConversationId: string | null;
  readonly callerId: string | undefined;
  readonly callerPrivilege: MemberPrivilege | undefined;
  /** Queued messages for the active conversation, oldest first (drives the pills). */
  readonly queuedMessages: QueuedMessage[];
  /** Enqueue a message on the active conversation (composer's `onQueue`). */
  readonly onQueueMessage: (text: string) => void;
  /** Remove a queued message by id (pill cancel). */
  readonly onCancelQueued: (id: string) => void;
  /** Number of queued messages on the active conversation. */
  readonly queueCount: number;
  /** Whether the active conversation's queue is at capacity. */
  readonly queueFull: boolean;
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
  // History lives in its own query now; prune there so the about-to-be-replaced
  // rows vanish in the same commit as the render-layer prune.
  queryClient.setQueryData<MessageResponse[]>(chatKeys.messages(conversationId), (old) =>
    old ? old.filter((m) => !idsToRemove.has(m.id)) : old
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

/**
 * Applies failed-branch error codes from the run result to a message set (the
 * failed model has no persisted row, so its tile keeps rendering the error).
 * Billed costs are NOT on the wire — they render from persisted data after
 * the post-run refetch.
 */
function attachModelErrorsToMessages(
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
    }
  }
}

/** Refusal codes a user can immediately retry (transient admission/serialization). */
const RETRYABLE_REFUSAL_CODES = new Set([
  'CONCURRENT_RUN',
  'INSUFFICIENT_ADMISSION',
  'ADMISSION_UNAVAILABLE',
  'RATE_LIMITED',
  'IDEMPOTENCY_BODY_MISMATCH',
]);

function turnErrorContent(error: unknown): { content: UserFacingMessage; retryable: boolean } {
  if (error instanceof ChatRequestError) {
    return {
      content: friendlyErrorMessage(error.code),
      retryable: RETRYABLE_REFUSAL_CODES.has(error.code),
    };
  }
  if (error instanceof ChatRunFailedError) {
    // Involuntary kills (deadline, engine failure) bill nothing — say so.
    return {
      content: customUserMessage(
        'This turn failed before anything was saved — you were not billed. Please try again.'
      ),
      retryable: true,
    };
  }
  return { content: friendlyErrorMessage('INTERNAL'), retryable: false };
}

function handleTurnError(
  error: unknown,
  failedContent: string,
  forkKey: string,
  promptInputRef: React.RefObject<PromptInputRef | null>
): void {
  const { content, retryable } = turnErrorContent(error);
  if (!(error instanceof ChatRequestError) && !(error instanceof ChatRunFailedError)) {
    console.error('Turn failed:', error);
    promptInputRef.current?.focus();
  }
  useChatErrorStore
    .getState()
    .setError(forkKey, createChatError({ content, retryable, failedContent }));
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
    setOptimisticMessageStageDone,
    setOptimisticMessageMediaStart,
    setOptimisticMessageMediaProgress,
    resetOptimisticMessageContent,
  } = useOptimisticMessages();

  const activeModality = useModelStore((state) => state.activeModality);
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const imageConfig = useModelStore((state) => state.imageConfig);
  const videoConfig = useModelStore((state) => state.videoConfig);
  const audioConfig = useModelStore((state) => state.audioConfig);
  // Single source of truth for web-search state (see useWebSearch). In the
  // authenticated chat `active === preferred`, so this is behavior-preserving.
  const { active: webSearchEnabled } = useWebSearch();
  const { isStreaming, startStream, startRegenerateStream, stopRun } =
    useChatStream('authenticated');
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

  // A transport disconnect never cancels a run — the server completes,
  // persists, and bills it (the answer is there on return). Only the explicit
  // stop control aborts, so unmount does no run teardown.
  React.useEffect(() => {
    return () => {
      useChatErrorStore.getState().clearAll();
    };
  }, []);

  const handleStreamStart = React.useCallback(
    (data: StartEventData) => {
      const { messages, assistantMessageIds } = processStartEvent(
        data,
        conversationIdRef.current,
        data.userMessageId
      );
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

  const handleStreamToken = React.useCallback((token: string, assistantMessageId: string) => {
    setLocalMessages((previous) => appendTokenToMessage(previous, assistantMessageId, token));
  }, []);

  const handleStreamModelError = React.useCallback((data: ModelErrorData) => {
    setLocalMessages((previous) =>
      previous.map((m) =>
        m.id === data.assistantMessageId ? { ...m, errorCode: data.code, content: '' } : m
      )
    );
  }, []);

  /**
   * Tracks which tiles of the active turn were sent as the Smart Model
   * sentinel, so `stream-start`'s resolved model id can flip the tile's
   * nametag (and light the "Smart" chip) — replacing the legacy
   * `stage:done` pre-inference event, which no longer exists on the wire.
   */
  const smartTileIdsRef = React.useRef(new Set<string>());

  const recordSmartTiles = React.useCallback((data: StartEventData) => {
    smartTileIdsRef.current = new Set(
      data.models
        .filter((entry) => entry.modelId === SMART_MODEL_ID)
        .map((entry) => entry.assistantMessageId)
    );
  }, []);

  const handleStreamModelResolved = React.useCallback(
    (assistantMessageId: string, modelId: string) => {
      if (!smartTileIdsRef.current.has(assistantMessageId)) return;
      setLocalMessages((previous) =>
        previous.map((m) =>
          m.id === assistantMessageId
            ? { ...m, modelName: modelId, resolvedModelName: modelId, isSmartModel: true }
            : m
        )
      );
    },
    []
  );

  /** A same-key clean re-execution restarted the answer: reset tile content. */
  const handleStreamRestart = React.useCallback((assistantMessageIds: string[]) => {
    const ids = new Set(assistantMessageIds);
    setLocalMessages((previous) =>
      previous.map((m) => (ids.has(m.id) ? { ...m, content: '' } : m))
    );
  }, []);

  // Media handlers for the new-chat flow (mutate localMessages, mirroring the
  // optimistic setters). `media-start` refines the creation-time mime;
  // `media-progress` drives the video bar; `media-done` is the authoritative
  // 100% — the wire never says it.
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

  const handleStreamMediaProgress = React.useCallback(
    (data: { assistantMessageId: string; percent: number }) => {
      setLocalMessages((previous) =>
        previous.map((m) =>
          m.id === data.assistantMessageId ? { ...m, mediaProgress: { percent: data.percent } } : m
        )
      );
    },
    []
  );

  const handleStreamMediaDone = React.useCallback((data: { assistantMessageId: string }) => {
    setLocalMessages((previous) =>
      previous.map((m) =>
        m.id === data.assistantMessageId ? { ...m, mediaProgress: { percent: 100 } } : m
      )
    );
  }, []);

  const createOptimisticStreamCallbacks = React.useCallback(
    (convId: string) => {
      // The assistant tile ids this turn owns. Captured in onStart so the
      // completion callbacks release ONLY this turn's tracking — a turn that
      // settles while a newer overlapping turn is mid-flight must never clear
      // the newer turn's streaming/persisting ids.
      let turnAssistantIds: string[] = [];
      return {
        onStart: (data: StartEventData) => {
          const { messages, assistantMessageIds } = processStartEvent(
            data,
            convId,
            data.userMessageId
          );
          recordSmartTiles(data);
          turnAssistantIds = assistantMessageIds;
          // Stamp the media backdrop hint from the first frame so a media turn
          // never flashes the text "thinking" indicator before media-start.
          const mediaInFlight = pendingMediaInFlight(activeModality, imageConfig, videoConfig);
          for (const msg of messages) {
            addOptimisticMessage(mediaInFlight ? { ...msg, mediaInFlight } : msg);
          }
          startStreamingIfNeeded(assistantMessageIds, state);
        },
        onToken: (token: string, assistantMessageId: string) => {
          updateOptimisticMessageContent(assistantMessageId, token);
        },
        onModelResolved: (assistantMessageId: string, modelId: string) => {
          if (!smartTileIdsRef.current.has(assistantMessageId)) return;
          // Reuses the stage-done setter: the resolved model replaces the
          // "Smart Model" nametag and lights the Smart chip, exactly as the
          // legacy classifier stage:done did.
          setOptimisticMessageStageDone(assistantMessageId, {
            stageId: 'smart-model',
            resolvedModelId: modelId,
            resolvedModelName: modelId,
          });
        },
        onRestart: (assistantMessageIds: string[]) => {
          for (const id of assistantMessageIds) resetOptimisticMessageContent(id);
        },
        onModelError: (data: ModelErrorData) => {
          setOptimisticMessageError(data.assistantMessageId, data.code);
        },
        onModelMediaStart: (data: ModelMediaStartData) => {
          const aspectRatio = requestedMediaAspectRatio(data.mediaType, imageConfig, videoConfig);
          setOptimisticMessageMediaStart(
            data.assistantMessageId,
            data.mediaType,
            data.mimeType,
            aspectRatio
          );
        },
        // Synthetic video progress: the wire sweeps 10..90 then heartbeats 95.
        onModelMediaProgress: (data: { assistantMessageId: string; percent: number }) => {
          setOptimisticMessageMediaProgress(data.assistantMessageId, data.percent);
        },
        // The wire never says 100 — media-done flips the synthetic bar to its
        // terminal state ahead of the persisted refetch.
        onModelMediaDone: (data: { assistantMessageId: string }) => {
          setOptimisticMessageMediaProgress(data.assistantMessageId, 100);
        },
        // Token streaming has ended for every model in this turn (terminal
        // stream events all arrived). The run is still settling server-side,
        // but the user has seen all the tokens — re-enable the input and let
        // `resolveMessageActions` show the toolbar now.
        onAllModelsComplete: () => {
          state.stopStreaming(turnAssistantIds);
        },
        // run-finished — settlement committed (or the turn is over either
        // way). Clear the persistence-tracking set so the next send doesn't
        // race against an in-flight commit and resolve the wrong
        // parentMessageId.
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
      setOptimisticMessageStageDone,
      resetOptimisticMessageContent,
      recordSmartTiles,
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
      const { models } = await startStream(
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
          onStart: (data: StartEventData) => {
            callbacks.onStart(data);
            params.onPlaceholders(data.models.map((m) => m.assistantMessageId));
          },
        }
      );
      // run-finished settled server-side: costs and media render from the
      // persisted rows this refetch loads (billed cost is never on the wire).
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
        const epoch = createFirstEpoch([accountPublicKey], conversationId, 1);
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

        if (!shouldStreamFirstTurn(response)) {
          // Idempotent: conversation existed — seed the conversation cache; the
          // separate history query loads any prior messages on mount.
          queryClient.setQueryData<ConversationDetailResponse>(chatKeys.conversation(realId), {
            conversation: response.conversation,
            membership: OWNER_MEMBERSHIP,
            forks: response.forks,
          });
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
        queryClient.setQueryData<ConversationDetailResponse>(chatKeys.conversation(realId), {
          conversation: response.conversation,
          membership: OWNER_MEMBERSHIP,
          forks: [],
        });
        queryClient.setQueryData<MessageResponse[]>(chatKeys.messages(realId), []);
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
            onStart: (data: StartEventData) => {
              handleStreamStart(data);
              recordSmartTiles(data);
              // for-loop, not .map: a nested arrow here would exceed the
              // function-nesting depth lint rule at this call site.
              for (const m of data.models) newChatAssistantIds.push(m.assistantMessageId);
            },
            onToken: handleStreamToken,
            onModelError: handleStreamModelError,
            onModelMediaStart: handleStreamMediaStart,
            onModelMediaProgress: handleStreamMediaProgress,
            onModelMediaDone: handleStreamMediaDone,
            onModelResolved: handleStreamModelResolved,
            onRestart: handleStreamRestart,
          }
        );

        attachModelErrorsToMessages(streamResult.models, setLocalMessages);

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

        // Seed cache so useConversation sees the conversation immediately.
        queryClient.setQueryData<ConversationDetailResponse>(chatKeys.conversation(realId), {
          conversation: conversationObject,
          membership: OWNER_MEMBERSHIP,
          forks: [],
        });
        queryClient.setQueryData<MessageResponse[]>(chatKeys.messages(realId), []);
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
        const { content, retryable } = turnErrorContent(streamError);
        useChatErrorStore
          .getState()
          .setError(MAIN_FORK_KEY, createChatError({ content, retryable, failedContent: message }));
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
    handleStreamModelResolved,
    handleStreamRestart,
    handleStreamMediaStart,
    handleStreamMediaProgress,
    handleStreamMediaDone,
    recordSmartTiles,
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

  // Live snapshot of the message set that composes a turn's inference history.
  // `executeSend` reads it AT CALL TIME rather than from its creation-time
  // closure: a drained send runs inside a long-lived loop that spans multiple
  // settles, so the closure arrays would be frozen at loop-start and each drained
  // message N+1 would omit messages 1..N and their assistant answers.
  //
  // Ordering that makes the ref read safe for N+1 (load-bearing): when message N's
  // `executeSend` resolves, the drain loop resumes on a MICROTASK and synchronously
  // reads this ref at the top of N+1's `executeSend`. At that read the ref still
  // carries message N's OPTIMISTIC turn (user + streamed assistant): React flushes
  // the promise-batched optimistic-tile removal and refetch as state updates on a
  // later macrotask (React commit), which cannot interleave into the microtask-only
  // hop from N resolving to N+1's synchronous read. So N+1 reads the pre-removal
  // committed snapshot, which includes message N. useLayoutEffect keeps the ref
  // current for ordinary renders; it is NOT what orders the ref ahead of the loop's
  // next microtask. Caveat: this relies on the removal render not flushing
  // synchronously before that continuation — updating the ref synchronously with
  // optimistic removal would open a removed-but-not-yet-refetched window.
  const inferenceSourceRef = React.useRef({ forkFilteredDecrypted, optimisticMessages });
  React.useLayoutEffect(() => {
    inferenceSourceRef.current = { forkFilteredDecrypted, optimisticMessages };
  }, [forkFilteredDecrypted, optimisticMessages]);

  /**
   * Send one specific message text through the run path and resolve once it has
   * FULLY settled: `{ ok: true }` when the run committed, `{ ok: false }` when it
   * refused/failed (error already surfaced). Takes explicit `content` rather than
   * reading `inputValue`, so the drain can send a dequeued message without the
   * `setInputValue`-then-send race (setState is async and may not have applied).
   */
  const executeSend = React.useCallback(
    async (
      content: string,
      convId: string,
      fundingSource: FundingSource
    ): Promise<{ ok: boolean }> => {
      const userMessageId = crypto.randomUUID();

      // Read the live message set (see `inferenceSourceRef`), not this callback's
      // creation-time closure. On a drained N+1 this synchronous read lands on the
      // microtask after N resolved, while N's optimistic turn is still committed —
      // so it carries messages 1..N for history and parentage.
      const { forkFilteredDecrypted: currentDecrypted, optimisticMessages: currentOptimistic } =
        inferenceSourceRef.current;

      // Resolve parent: last message in the current view (fork-filtered + optimistic)
      const allCurrentMessages = [...currentDecrypted, ...currentOptimistic];
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
        ...currentDecrypted.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        ...currentOptimistic.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        { role: 'user' as const, content },
      ];

      // This turn's assistant tile ids, captured from the `start` event. Scoped
      // locally (not via a shared ref) so an overlapping send can't make this
      // turn's error cleanup remove the other turn's tiles.
      const placeholderIds: string[] = [];

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
        return { ok: true };
      } catch (error: unknown) {
        if (error instanceof ChatRequestError && error.code === 'INSUFFICIENT_ADMISSION') {
          await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        }
        handleTurnError(error, content, errorForkKey, promptInputRef);

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
        return { ok: false };
      }
    },
    [
      callerId,
      addOptimisticMessage,
      removeOptimisticMessage,
      executeStream,
      activeForkId,
      errorForkKey,
      state,
      queryClient,
      promptInputRef,
    ]
  );

  // True while a drained send is in flight — the double-send guard. A settle
  // event that fires while the drain loop is already running is ignored.
  const drainingRef = React.useRef(false);
  // Mirrors `isStreaming` for synchronous reads inside the imperative drain,
  // which must never start a send while a run is active.
  const isStreamingRef = React.useRef(isStreaming);
  React.useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const drainQueue = React.useCallback((): void => {
    // Invariant: never start a drained send while a run is active, and never let
    // a second settle event kick off a parallel drain (double-send).
    if (drainingRef.current || isStreamingRef.current) return;
    const convId = realConversationId;
    if (!convId || useMessageQueueStore.getState().count(convId) === 0) return;
    drainingRef.current = true;
    void (async () => {
      try {
        // Drain FIFO, one message at a time, each awaited to its FULL settle
        // (executeSend resolves post-endStream / onAllStreamsSettled). Draining
        // at the terminal settle — never at the earlier onAllModelsComplete — is
        // load-bearing: it guarantees the next drained message's optimistic
        // parent is the just-persisted assistant turn, not a mid-flight tile
        // whose id resolves the wrong parentMessageId. A failed send pauses the
        // drain and restores that message's text to the composer; the remaining
        // queued messages are left untouched (never dropped, never auto-sent).
        while (useMessageQueueStore.getState().count(convId) > 0) {
          const head = useMessageQueueStore.getState().dequeueHead(convId);
          if (!head) break;
          const result = await executeSend(head.text, convId, DRAIN_FUNDING_SOURCE);
          if (!result.ok) {
            state.setInputValue(head.text);
            break;
          }
        }
      } finally {
        drainingRef.current = false;
      }
    })();
  }, [realConversationId, executeSend, state]);

  // Read the latest drainQueue from effects/callbacks without making them depend
  // on its per-render identity.
  const drainQueueRef = React.useRef(drainQueue);
  React.useEffect(() => {
    drainQueueRef.current = drainQueue;
  });

  // Mount-resume + terminal-settle trigger. `isStreaming` flips false only in the
  // stream hook's `finally` (post onAllStreamsSettled), so reacting to
  // `!isStreaming` starts the drain at the terminal settle. On mount, an idle
  // conversation with a non-empty queue begins draining immediately.
  React.useEffect(() => {
    if (!isStreaming) drainQueueRef.current();
  }, [isStreaming, realConversationId]);

  const handleSend = React.useCallback(
    (fundingSource: FundingSource) => {
      const prepared = prepareMessageInput();
      if (!prepared) {
        return;
      }
      void (async () => {
        const result = await executeSend(prepared.content, prepared.convId, fundingSource);
        // A user send that fully settles drains the next queued message. On
        // failure the queue is preserved (the drain does not start), so nothing
        // is lost and nothing auto-sends behind a failure.
        if (result.ok) drainQueueRef.current();
      })();
    },
    [prepareMessageInput, executeSend]
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
          client.chat[':conversationId'].message.$post({
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
      // same per-tile routing without divergent code paths.
      const callbacks = createOptimisticStreamCallbacks(realConversationId);
      // Populated synchronously inside onStart (which fires during the await
      // below, before stream completion). Safe to read post-await — the
      // stream resolves strictly after onStart, so the array is fully
      // populated by then.
      const placeholderIds: string[] = [];

      void (async () => {
        try {
          await startRegenerateStream(request, {
            ...callbacks,
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

          if (error instanceof ChatRequestError && error.code === 'INSUFFICIENT_ADMISSION') {
            await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
          }
          handleTurnError(error, userContent, errorForkKey, promptInputRef);

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

  /**
   * Explicit user stop — plain HTTP by design (a WS-blocked user can always
   * abort a paid run). The server settles + BILLS the partial; the streamed
   * partial stays rendered and the run-finished refetch loads the persisted
   * rows. `stopped:false` (run already over) is a benign no-op.
   */
  const handleStop = React.useCallback(() => {
    if (!realConversationId) return;
    void (async (): Promise<void> => {
      try {
        await stopRun(realConversationId);
      } catch (error) {
        console.error('Stop failed:', error);
      }
    })();
  }, [realConversationId, stopRun]);

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

  // Subscribe to the whole per-conversation queue map (a stable reference until a
  // queue actually changes), then derive this conversation's slice — reactive
  // without the fresh-`[]` identity churn of selecting `queued(convId)` directly.
  const enqueue = useMessageQueueStore((s) => s.enqueue);
  const cancelQueued = useMessageQueueStore((s) => s.cancel);
  const queuesByConversation = useMessageQueueStore((s) => s.queuesByConversation);
  const queuedMessages = React.useMemo(
    () =>
      realConversationId ? (queuesByConversation[realConversationId] ?? EMPTY_QUEUE) : EMPTY_QUEUE,
    [queuesByConversation, realConversationId]
  );
  const queueCount = queuedMessages.length;
  const queueFull = React.useMemo(
    () => (realConversationId ? useMessageQueueStore.getState().isFull(realConversationId) : false),
    [realConversationId, queuedMessages]
  );
  const onQueueMessage = React.useCallback(
    (text: string): void => {
      if (realConversationId) enqueue(realConversationId, text);
    },
    [enqueue, realConversationId]
  );
  const onCancelQueued = React.useCallback(
    (id: string): void => {
      if (realConversationId) cancelQueued(realConversationId, id);
    },
    [cancelQueued, realConversationId]
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
    handleStop,
    promptInputRef,
    errorMessageId,
    realConversationId,
    callerId,
    callerPrivilege,
    queuedMessages,
    onQueueMessage,
    onCancelQueued,
    queueCount,
    queueFull,
  };
}

/**
 * Whether a create-conversation response is for a newly created row (whose first
 * turn must be streamed) versus an idempotent return of an already-existing
 * conversation (seeded into cache, no re-stream). The backend outcome field is
 * `created`; reading a wrong field name is compile-silent through `fetchJson`'s
 * cast (an undefined read makes `!response.<field>` always true, so new
 * conversations would never stream their first turn), so the decision is pinned
 * as a named helper with a test over both branches.
 */
export function shouldStreamFirstTurn(response: { created: boolean }): boolean {
  return response.created;
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
