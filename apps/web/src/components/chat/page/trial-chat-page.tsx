import * as React from 'react';
import { Navigate } from '@tanstack/react-router';
import { ROUTES, legacyFriendlyErrorMessage, customUserMessage } from '@hushbox/shared';
import { useIsMobile } from '@hushbox/ui';
import { ChatLayout } from '@/components/chat/layout/chat-layout';
import { createTrialMessage } from '@/lib/chat-messages';
import { buildMessagesForRegeneration } from '@/lib/chat-regeneration';
import { useChatPageState } from '@/hooks/chat/use-chat-page';
import { useChatStream, TrialRateLimitError } from '@/hooks/chat/use-chat-stream';
import { useTrialChatStore } from '@/stores/trial-chat';
import { useModelStore, getPrimaryModel } from '@/stores/model';
import { useChatErrorStore, createChatError, MAIN_FORK_KEY } from '@/stores/chat-error';
import { useChatEditStore } from '@/stores/chat-edit';
import { useStreamingActivityStore } from '@/stores/streaming-activity';
import { useSession } from '@/lib/auth';
import type { PromptInputRef } from '@/components/chat/input/prompt-input';
import type { Message } from '@/lib/api';

/**
 * Trial messages lack parentMessageId, so resolve assistant targets to
 * the preceding user message by position (mirrors resolveRegenerateTarget
 * which uses parentMessageId for authenticated messages).
 */
function resolveTrialTarget(
  messages: { id: string; role: string }[],
  targetMessageId: string
): { resolvedId: string; targetRole: string } {
  const target = messages.find((m) => m.id === targetMessageId);
  if (!target) return { resolvedId: targetMessageId, targetRole: 'user' };

  if (target.role === 'assistant') {
    const targetIndex = messages.findIndex((m) => m.id === targetMessageId);
    const precedingUser = messages.slice(0, targetIndex).findLast((m) => m.role === 'user');
    return { resolvedId: precedingUser?.id ?? targetMessageId, targetRole: 'assistant' };
  }

  return { resolvedId: targetMessageId, targetRole: target.role };
}

export function TrialChatPage(): React.JSX.Element {
  const state = useChatPageState();
  const isMobile = useIsMobile();
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const creationStartedRef = React.useRef(false);
  const [creationStarted, setCreationStarted] = React.useState(false);

  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = !isSessionPending && Boolean(session?.user);

  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const { isStreaming, startStream } = useChatStream('trial');
  const { editingMessageId, startEditing, clearEditing } = useChatEditStore();

  const {
    messages: trialMessages,
    pendingMessage: trialPendingMessage,
    isRateLimited,
    addMessage: addTrialMessage,
    appendToMessage: appendToTrialMessage,
    clearPendingMessage: clearTrialPendingMessage,
    setRateLimited,
    removeMessagesAfter,
    removeMessage,
    setMessageStageDone,
  } = useTrialChatStore();

  // Trial chats are linear (no forks), so every read/write keys off
  // MAIN_FORK_KEY. Same store, single slot in practice.
  const chatError = useChatErrorStore((s) => s.errorsByFork[MAIN_FORK_KEY] ?? null);

  React.useEffect(() => {
    useChatErrorStore.getState().clearAll();
    return () => {
      useChatErrorStore.getState().clearAll();
    };
  }, []);

  const handleStreamError = React.useCallback(
    (error: unknown): void => {
      const lastUserMsg = trialMessages.findLast((m) => m.role === 'user');
      if (error instanceof TrialRateLimitError) {
        useChatErrorStore.getState().setError(
          MAIN_FORK_KEY,
          createChatError({
            content: customUserMessage(
              `You've used all 5 free messages today. [Sign up](${ROUTES.SIGNUP}) to continue chatting!`
            ),
            retryable: false,
            failedContent: lastUserMsg?.content ?? '',
          })
        );
        setRateLimited(true);
      } else {
        console.error('Trial chat error:', error);
        useChatErrorStore.getState().setError(
          MAIN_FORK_KEY,
          createChatError({
            content: legacyFriendlyErrorMessage('INTERNAL'),
            retryable: false,
            failedContent: lastUserMsg?.content ?? '',
          })
        );
      }
    },
    [setRateLimited, trialMessages]
  );

  const primaryModelId = getPrimaryModel(selectedModels).id;

  const executeStream = React.useCallback(
    async (apiMessages: { role: 'user' | 'assistant'; content: string }[]): Promise<void> => {
      const placeholderIds: string[] = [];
      try {
        await startStream(
          { messages: apiMessages, model: primaryModelId },
          {
            onStart: ({ models }) => {
              const firstModel = models[0];
              if (!firstModel?.assistantMessageId) return;
              placeholderIds.push(firstModel.assistantMessageId);
              const assistantMessage = createTrialMessage(
                'assistant',
                '',
                firstModel.assistantMessageId,
                firstModel.modelId
              );
              addTrialMessage(assistantMessage);
              state.startStreaming([firstModel.assistantMessageId]);
            },
            onToken: (token) => {
              const ids = state.streamingMessageIdsRef.current;
              const msgId = ids.size > 0 ? ids.values().next().value : null;
              if (msgId) {
                appendToTrialMessage(msgId, token);
              }
            },
            // Smart Model: the classifier resolves a real model mid-stream and
            // reports it here. Record it so the nametag shows the resolved name
            // instead of the "smart-model" placeholder, matching the authed flow.
            onStageDone: (data) => {
              setMessageStageDone(data.assistantMessageId, data.payload);
            },
            // Wrapper's finally fires this on error/abort too — single
            // cleanup path for persistingMessageIds regardless of outcome.
            onAllStreamsSettled: () => {
              state.stopPersisting(placeholderIds);
            },
          }
        );

        state.stopStreaming(placeholderIds);
        useStreamingActivityStore.getState().endStream();
      } catch (error) {
        state.stopStreaming(placeholderIds);
        useStreamingActivityStore.getState().endStream();
        // Stream threw after `start` fired: drop the assistant placeholder so
        // it doesn't render as an invisible empty bubble whose action toolbar
        // floats above the chat-error tile.
        for (const id of placeholderIds) {
          removeMessage(id);
        }
        handleStreamError(error);
      }
    },
    [
      startStream,
      primaryModelId,
      addTrialMessage,
      appendToTrialMessage,
      state,
      handleStreamError,
      removeMessage,
      setMessageStageDone,
    ]
  );

  const handleTrialFirstMessage = React.useCallback(
    async (content: string): Promise<void> => {
      clearTrialPendingMessage();
      useChatErrorStore.getState().clearError(MAIN_FORK_KEY);

      const userMessage = createTrialMessage('user', content);
      addTrialMessage(userMessage);

      await executeStream([{ role: 'user' as const, content }]);
    },
    [clearTrialPendingMessage, addTrialMessage, executeStream]
  );

  React.useEffect(() => {
    if (trialPendingMessage && !creationStartedRef.current && !isStreaming) {
      creationStartedRef.current = true;
      setCreationStarted(true);
      void handleTrialFirstMessage(trialPendingMessage);
    }
  }, [trialPendingMessage, isStreaming, handleTrialFirstMessage]);

  const handleTrialRegenerate = React.useCallback(
    async (targetMessageId: string, editedContent?: string): Promise<void> => {
      if (isStreaming || isRateLimited) return;
      if (!trialMessages.some((m) => m.id === targetMessageId)) return;

      const { resolvedId, targetRole } = resolveTrialTarget(trialMessages, targetMessageId);

      useChatErrorStore.getState().clearError(MAIN_FORK_KEY);

      const effectiveAction = editedContent ? ('edit' as const) : ('retry' as const);
      const inferenceMessages = buildMessagesForRegeneration(
        trialMessages,
        resolvedId,
        effectiveAction,
        editedContent
      );
      const apiMessages = inferenceMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      // Truncation by original target role, not by action
      if (targetRole === 'assistant') {
        const targetIndex = trialMessages.findIndex((m) => m.id === targetMessageId);
        const precedingMessage = trialMessages[targetIndex - 1];
        if (targetIndex > 0 && precedingMessage) {
          removeMessagesAfter(precedingMessage.id);
        }
      } else {
        removeMessagesAfter(targetMessageId);
      }

      await executeStream(apiMessages);
    },
    [isStreaming, isRateLimited, trialMessages, removeMessagesAfter, executeStream]
  );

  const handleTrialSubmit = React.useCallback(async () => {
    const content = state.inputValue.trim();
    if (!content || isStreaming || isRateLimited) return;

    if (editingMessageId) {
      void handleTrialRegenerate(editingMessageId, content);
      clearEditing();
      return;
    }

    useChatErrorStore.getState().clearError(MAIN_FORK_KEY);
    state.clearInput();
    if (!isMobile) {
      promptInputRef.current?.focus();
    }

    const userMessage = createTrialMessage('user', content);
    addTrialMessage(userMessage);

    const apiMessages = [...trialMessages, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    await executeStream(apiMessages);
  }, [
    state,
    isStreaming,
    isRateLimited,
    isMobile,
    trialMessages,
    addTrialMessage,
    executeStream,
    editingMessageId,
    clearEditing,
    handleTrialRegenerate,
  ]);

  const handleEdit = React.useCallback(
    (messageId: string, content: string): void => {
      startEditing(messageId, content);
      state.setInputValue(content);
    },
    [startEditing, state]
  );

  const handleCancelEdit = React.useCallback((): void => {
    clearEditing();
    state.setInputValue('');
  }, [clearEditing, state]);

  if (!isSessionPending && isAuthenticated) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  if (!trialPendingMessage && trialMessages.length === 0 && !creationStarted) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  const historyCharacters = trialMessages.reduce(
    (total, message) => total + message.content.length,
    0
  );

  const displayMessages: Message[] = [...(trialMessages as Message[])];
  if (chatError) {
    displayMessages.push({
      id: chatError.id,
      conversationId: 'trial',
      role: 'assistant',
      content: chatError.content,
      createdAt: new Date().toISOString(),
      modelName: primaryModelId,
    });
  }

  return (
    <ChatLayout
      messages={displayMessages}
      streamingMessageIds={state.streamingMessageIds}
      persistingMessageIds={state.persistingMessageIds}
      inputValue={state.inputValue}
      onInputChange={state.setInputValue}
      onSubmit={() => void handleTrialSubmit()}
      inputDisabled={isRateLimited}
      isProcessing={isStreaming}
      historyCharacters={historyCharacters}
      isAuthenticated={false}
      promptInputRef={promptInputRef}
      errorMessageId={chatError?.id}
      onRegenerate={(messageId: string) => void handleTrialRegenerate(messageId)}
      onEdit={handleEdit}
      isEditing={editingMessageId !== null}
      onCancelEdit={handleCancelEdit}
    />
  );
}
