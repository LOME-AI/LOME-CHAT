import * as React from 'react';
import { Lock } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { MessageList, type MessageListHandle } from '@/components/chat/message/message-list';
import { TypingIndicator } from '@/components/chat/indicators/typing-indicator';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';
import type { Message } from '@/lib/api';
import type { MemberPrivilege } from '@hushbox/shared';

function buildMessageListGroupProps(
  groupChat: GroupChatProps | undefined
): Partial<React.ComponentProps<typeof MessageList>> {
  if (!groupChat || (groupChat.members.length <= 1 && groupChat.links.length === 0)) {
    return {};
  }
  return {
    isGroupChat: true,
    currentUserId: groupChat.currentUserId,
    // MessageList resolves sender names by userId; a link guest (null userId)
    // can never match a message senderId (guests are resolved via `links`), so
    // narrow to real members here rather than widen the whole message subtree.
    members: groupChat.members.filter(
      (m): m is { id: string; userId: string; username: string; privilege: string } =>
        m.userId !== null && m.username !== null
    ),
    links: groupChat.links,
  };
}

interface ChatMainContentProps {
  readonly messages: Message[];
  readonly streamingMessageIds: Set<string>;
  readonly persistingMessageIds: Set<string> | undefined;
  readonly errorMessageId: string | undefined;
  readonly modelName: string;
  readonly onShare: (messageId: string) => void;
  readonly onRegenerate: ((messageId: string) => void) | undefined;
  readonly onEdit: ((messageId: string, content: string) => void) | undefined;
  readonly onFork: ((messageId: string) => void) | undefined;
  readonly isDecrypting: boolean | undefined;
  readonly groupChat: GroupChatProps | undefined;
  readonly virtuosoRef: React.RefObject<MessageListHandle | null>;
  readonly isAuthenticated: boolean;
  readonly isLinkGuest: boolean;
  readonly callerPrivilege: MemberPrivilege | undefined;
  readonly conversationId: string | undefined;
  readonly activeForkId: string | null | undefined;
  readonly messagesReady: boolean | undefined;
}

function buildOptionalCallbackProps(
  props: Pick<ChatMainContentProps, 'onRegenerate' | 'onEdit' | 'onFork'>
): Partial<React.ComponentProps<typeof MessageList>> {
  return {
    ...(props.onRegenerate !== undefined && { onRegenerate: props.onRegenerate }),
    ...(props.onEdit !== undefined && { onEdit: props.onEdit }),
    ...(props.onFork !== undefined && { onFork: props.onFork }),
  };
}

function DecryptingPlaceholder(): React.JSX.Element {
  return (
    <div
      className="flex flex-1 items-center justify-center"
      data-testid={TEST_IDS.sharedConversationLoading}
    >
      <div className="flex flex-col items-center gap-3">
        <Lock className="text-muted-foreground h-8 w-8" />
        <span className="text-muted-foreground text-sm">Decrypting your conversation...</span>
      </div>
    </div>
  );
}

function ChatMainContentInner({
  messages,
  streamingMessageIds,
  persistingMessageIds,
  errorMessageId,
  modelName,
  onShare,
  onRegenerate,
  onEdit,
  onFork,
  isDecrypting,
  groupChat,
  virtuosoRef,
  isAuthenticated,
  isLinkGuest,
  callerPrivilege,
  conversationId,
  activeForkId,
  messagesReady,
}: Readonly<ChatMainContentProps>): React.JSX.Element {
  const showDecrypting = messages.length === 0 && isDecrypting;
  const typingMembers = groupChat?.typingUserIds;
  const showTyping = typingMembers !== undefined && typingMembers.size > 0;

  // Stabilize the props derived from primitives so the memoized MessageList
  // sees identical references across re-renders that don't change its inputs.
  const conversationKey = `${conversationId ?? 'init'}-${activeForkId ?? 'main'}`;
  const optionalCallbackProps = React.useMemo(
    () => buildOptionalCallbackProps({ onRegenerate, onEdit, onFork }),
    [onRegenerate, onEdit, onFork]
  );
  const groupProps = React.useMemo(() => buildMessageListGroupProps(groupChat), [groupChat]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {showDecrypting ? (
        <DecryptingPlaceholder />
      ) : (
        <MessageList
          ref={virtuosoRef}
          messages={messages}
          streamingMessageIds={streamingMessageIds}
          persistingMessageIds={persistingMessageIds}
          errorMessageId={errorMessageId}
          modelName={modelName}
          onShare={onShare}
          isAuthenticated={isAuthenticated}
          isLinkGuest={isLinkGuest}
          callerPrivilege={callerPrivilege}
          messagesReady={messagesReady}
          conversationKey={conversationKey}
          {...optionalCallbackProps}
          {...groupProps}
        />
      )}
      {showTyping && (
        <TypingIndicator typingUserIds={typingMembers} members={groupChat?.members ?? []} />
      )}
    </div>
  );
}

// Memoized so a prompt-input keystroke (which re-renders the chat layout but
// leaves these props referentially stable) does not re-render the virtualized
// MessageList. Requires the parent to pass stable callback references; see
// authenticated-chat-page.tsx.
export const ChatMainContent = React.memo(ChatMainContentInner);
