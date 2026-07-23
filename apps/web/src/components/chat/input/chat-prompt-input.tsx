import * as React from 'react';
import { PromptInput } from '@/components/chat/input/prompt-input';
import { getPromptPlaceholder } from '@/lib/modality-strings';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';
import type { ChatSearchProps, PromptInputRef } from '@/components/chat/input/prompt-input';
import type { FundingSource, MemberPrivilege, ChatModality } from '@hushbox/shared';

interface ChatPromptInputProps {
  readonly promptInputRef: React.RefObject<PromptInputRef | null>;
  readonly inputValue: string;
  readonly onInputChange: (value: string) => void;
  readonly handleSubmit: (fundingSource: FundingSource) => void;
  readonly historyCharacters: number;
  readonly inputDisabled: boolean;
  readonly isProcessing: boolean;
  readonly onStop?: (() => void) | undefined;
  readonly onQueue?: ((text: string) => void) | undefined;
  readonly queueCount?: number | undefined;
  readonly queueFull?: boolean | undefined;
  readonly isMobile: boolean;
  readonly conversationId: string | undefined;
  readonly groupChat: GroupChatProps | undefined;
  readonly callerPrivilege: MemberPrivilege | undefined;
  readonly handleSubmitUserOnly: () => void;
  readonly handleTypingChange: (isTyping: boolean) => void;
  readonly searchProps: ChatSearchProps | undefined;
  readonly isAuthenticated: boolean;
  readonly isEditing?: boolean | undefined;
  readonly onCancelEdit?: (() => void) | undefined;
  readonly activeModality: ChatModality;
  readonly onSelectModality: (modality: ChatModality) => void;
}

export interface ChatHeaderGroupProps {
  // Link-guest members carry null userId/username (see GroupChatProps.members).
  members?: { id: string; userId: string | null; username: string | null }[] | undefined;
  onlineMemberIds?: Set<string> | undefined;
  onFacepileClick?: (() => void) | undefined;
}

export function buildChatHeaderGroupProps(
  groupChat: GroupChatProps | undefined,
  onFacepileClick: () => void
): ChatHeaderGroupProps {
  if (!groupChat) return {};
  return {
    members: groupChat.members,
    onlineMemberIds: groupChat.onlineMemberIds,
    onFacepileClick,
  };
}

interface BuildPromptInputPropsInput {
  readonly groupChat: GroupChatProps | undefined;
  readonly conversationId: string | undefined;
  readonly callerPrivilege: MemberPrivilege | undefined;
  readonly isEditing: boolean | undefined;
  readonly onCancelEdit: (() => void) | undefined;
  readonly handleSubmitUserOnly: () => void;
  readonly handleTypingChange: (isTyping: boolean) => void;
}

function resolveConversationProps(
  groupChat: GroupChatProps | undefined,
  conversationId: string | undefined,
  callerPrivilege: MemberPrivilege | undefined
): Partial<React.ComponentProps<typeof PromptInput>> {
  if (groupChat !== undefined) {
    return {
      conversationId: groupChat.conversationId,
      currentUserPrivilege: groupChat.currentUserPrivilege,
    };
  }
  const result: Partial<React.ComponentProps<typeof PromptInput>> = {};
  if (conversationId !== undefined) result.conversationId = conversationId;
  if (callerPrivilege !== undefined) result.currentUserPrivilege = callerPrivilege;
  return result;
}

function resolveGroupChatProps(
  groupChat: GroupChatProps | undefined,
  handleSubmitUserOnly: () => void,
  handleTypingChange: (isTyping: boolean) => void
): Partial<React.ComponentProps<typeof PromptInput>> {
  if (!groupChat) return {};
  const result: Partial<React.ComponentProps<typeof PromptInput>> = {};
  if (groupChat.members.length > 1 || groupChat.links.length > 0) {
    result.isGroupChat = true;
    result.onSubmitUserOnly = handleSubmitUserOnly;
  }
  if (groupChat.ws !== undefined) {
    result.onTypingChange = handleTypingChange;
  }
  return result;
}

function buildPromptInputProps(
  input: BuildPromptInputPropsInput
): Partial<React.ComponentProps<typeof PromptInput>> {
  return {
    ...resolveConversationProps(input.groupChat, input.conversationId, input.callerPrivilege),
    ...resolveGroupChatProps(input.groupChat, input.handleSubmitUserOnly, input.handleTypingChange),
    ...(input.isEditing !== undefined && { isEditing: input.isEditing }),
    ...(input.onCancelEdit !== undefined && { onCancelEdit: input.onCancelEdit }),
  };
}

export function ChatPromptInput({
  promptInputRef,
  inputValue,
  onInputChange,
  handleSubmit,
  historyCharacters,
  inputDisabled,
  isProcessing,
  onStop,
  onQueue,
  queueCount,
  queueFull,
  isMobile,
  conversationId,
  groupChat,
  callerPrivilege,
  handleSubmitUserOnly,
  handleTypingChange,
  searchProps,
  isAuthenticated,
  isEditing,
  onCancelEdit,
  activeModality,
  onSelectModality,
}: Readonly<ChatPromptInputProps>): React.JSX.Element {
  const spreadProps = buildPromptInputProps({
    groupChat,
    conversationId,
    callerPrivilege,
    isEditing,
    onCancelEdit,
    handleSubmitUserOnly,
    handleTypingChange,
  });

  const placeholder = getPromptPlaceholder(activeModality, 'Type a message...');

  return (
    <PromptInput
      ref={promptInputRef}
      value={inputValue}
      onChange={onInputChange}
      onSubmit={handleSubmit}
      placeholder={placeholder}
      historyCharacters={historyCharacters}
      disabled={inputDisabled}
      isProcessing={isProcessing}
      {...(onStop !== undefined && { onStop })}
      {...(onQueue !== undefined && { onQueue })}
      {...(queueCount !== undefined && { queueCount })}
      {...(queueFull !== undefined && { queueFull })}
      // eslint-disable-next-line jsx-a11y/no-autofocus -- desktop-only focus management for chat composer; mobile is excluded to avoid keyboard popup
      autoFocus={!isMobile}
      isAuthenticated={isAuthenticated}
      activeModality={activeModality}
      onSelectModality={onSelectModality}
      {...(searchProps !== undefined && { searchProps })}
      {...spreadProps}
    />
  );
}
