import * as React from 'react';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { MOCK_MODELS } from '@lome-chat/shared';
import { ChatHeader } from '@/components/chat/chat-header';
import { MessageList } from '@/components/chat/message-list';
import { PromptInput } from '@/components/chat/prompt-input';
import { useConversation, useMessages, useSendMessage } from '@/hooks/chat';
import { useModelStore } from '@/stores/model';
import type { Message } from '@/lib/api';

export const Route = createFileRoute('/_app/chat/$conversationId')({
  component: ChatConversation,
});

function ChatConversation(): React.JSX.Element {
  const { conversationId } = Route.useParams();
  const isNewChat = conversationId === 'new';

  // Model selection from store
  const { selectedModelId, setSelectedModelId } = useModelStore();

  // Fetch real data for existing conversations
  const { data: conversation, isLoading: isConversationLoading } = useConversation(
    isNewChat ? '' : conversationId
  );
  const { data: apiMessages, isLoading: isMessagesLoading } = useMessages(
    isNewChat ? '' : conversationId
  );

  const sendMessage = useSendMessage();

  const isLoading = isConversationLoading || isMessagesLoading;

  // Local input value for PromptInput
  const [inputValue, setInputValue] = React.useState('');

  // Local optimistic messages (shown before API confirms)
  const [optimisticMessages, setOptimisticMessages] = React.useState<Message[]>([]);

  // Combine API messages with optimistic messages
  const allMessages = React.useMemo(() => {
    const messages = apiMessages ?? [];
    // Filter out optimistic messages that now exist in API response
    const apiMessageIds = new Set(messages.map((m) => m.id));
    const pendingOptimistic = optimisticMessages.filter((m) => !apiMessageIds.has(m.id));
    return [...messages, ...pendingOptimistic];
  }, [apiMessages, optimisticMessages]);

  // Clear optimistic messages when API messages update
  React.useEffect(() => {
    if (apiMessages && apiMessages.length > 0) {
      setOptimisticMessages([]);
    }
  }, [apiMessages]);

  const handleSend = (): void => {
    const content = inputValue.trim();
    if (!content || isNewChat) {
      return;
    }

    // Clear input immediately
    setInputValue('');

    // Create optimistic message for immediate UI feedback
    const optimisticMessage: Message = {
      id: crypto.randomUUID(),
      conversationId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    setOptimisticMessages((prev) => [...prev, optimisticMessage]);

    // Send to API
    sendMessage.mutate(
      {
        conversationId,
        message: {
          role: 'user',
          content,
        },
      },
      {
        onSuccess: () => {
          // Clear optimistic message - API invalidation will fetch real message
          setOptimisticMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
        },
        onError: () => {
          // Remove failed optimistic message
          setOptimisticMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
        },
      }
    );
  };

  // Redirect new chat to /chat - should create via NewChatPage
  if (isNewChat) {
    return <Navigate to="/chat" />;
  }

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatHeader
          models={MOCK_MODELS}
          selectedModelId={selectedModelId}
          onModelSelect={setSelectedModelId}
        />
        <div className="flex flex-1 items-center justify-center">
          <span className="text-muted-foreground">Loading conversation...</span>
        </div>
      </div>
    );
  }

  // Redirect to /chat if conversation doesn't exist
  if (!conversation) {
    return <Navigate to="/chat" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        models={MOCK_MODELS}
        selectedModelId={selectedModelId}
        onModelSelect={setSelectedModelId}
        title={conversation.title}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {allMessages.length > 0 && <MessageList messages={allMessages} />}
      </div>
      <div className="border-t p-4">
        <PromptInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSend}
          placeholder="Type a message..."
          maxTokens={2000}
          rows={3}
          disabled={sendMessage.isPending}
        />
      </div>
    </div>
  );
}
