import type * as React from 'react';
import type { ChatLayoutProps, GroupChatProps } from '@/components/chat/layout/chat-layout';
import type { MemberSidebar } from '@/components/chat/member/member-sidebar';
import type { Message, MessageMediaItem } from '@/lib/api';

interface MobileInputStyleInput {
  readonly isMobile: boolean;
  readonly keyboardOffset: number;
  readonly isKeyboardVisible: boolean;
}

export function getMobileInputStyle(input: MobileInputStyleInput): React.CSSProperties | undefined {
  if (!input.isMobile) return undefined;
  return {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: `${String(input.keyboardOffset)}px`,
    paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
    transition: input.isKeyboardVisible ? 'none' : 'bottom 0.2s ease-out',
    zIndex: 10,
  };
}

export function getContentAreaStyle(
  isMobile: boolean,
  inputHeight: number
): React.CSSProperties | undefined {
  if (isMobile && inputHeight > 0) return { marginBottom: inputHeight };
  return undefined;
}

interface WebSocketAttributes {
  wsConnected: string | undefined;
  wsReady: string | undefined;
}

export function getWebSocketAttributes(
  ws: { connected: boolean; ready: boolean } | undefined
): WebSocketAttributes {
  return {
    wsConnected: ws?.connected === true ? 'true' : undefined,
    wsReady: ws?.ready === true ? 'true' : undefined,
  };
}

interface ChatLayoutDerivedInput {
  readonly premiumIds: Set<string>;
  readonly tierInfo: { canAccessPremium: boolean } | undefined;
  readonly shareMessageId: string | null;
  readonly messages: Message[];
}

interface SharedMessageFields {
  sharedMessageContent: string | null;
  sharedMessageEpochNumber: number | null;
  sharedMessageWrappedContentKey: string | null;
  sharedMessageMediaItems: MessageMediaItem[] | null;
  // Canonicalizes a null/scrubbed sender to '' — the exact value the server
  // bound into the content-location AAD, so the share-dialog media preview can
  // reconstruct the envelope (mirrors the message-item media/text path).
  sharedMessageSenderId: string;
}

export interface ChatLayoutDerivedState extends SharedMessageFields {
  premiumIds: Set<string>;
  canAccessPremium: boolean;
}

function findSharedMessage(messages: Message[], shareMessageId: string | null): Message | null {
  if (!shareMessageId) return null;
  return messages.find((m) => m.id === shareMessageId) ?? null;
}

function deriveSharedMessageFields(sharedMessage: Message | null): SharedMessageFields {
  if (sharedMessage === null) {
    return {
      sharedMessageContent: null,
      sharedMessageEpochNumber: null,
      sharedMessageWrappedContentKey: null,
      sharedMessageMediaItems: null,
      sharedMessageSenderId: '',
    };
  }
  return {
    sharedMessageContent: sharedMessage.content,
    sharedMessageEpochNumber: sharedMessage.epochNumber ?? null,
    sharedMessageWrappedContentKey: sharedMessage.wrappedContentKey ?? null,
    sharedMessageMediaItems: sharedMessage.mediaItems ?? null,
    sharedMessageSenderId: sharedMessage.senderId ?? '',
  };
}

export function resolveChatLayoutDerivedState(
  input: ChatLayoutDerivedInput
): ChatLayoutDerivedState {
  const sharedMessage = findSharedMessage(input.messages, input.shareMessageId);
  return {
    premiumIds: input.premiumIds,
    canAccessPremium: input.tierInfo?.canAccessPremium ?? false,
    ...deriveSharedMessageFields(sharedMessage),
  };
}

export function buildMemberSidebarProps(
  groupChat: GroupChatProps | undefined
): Partial<React.ComponentProps<typeof MemberSidebar>> {
  if (groupChat === undefined) return {};
  return {
    members: groupChat.members,
    links: groupChat.links,
    onlineMemberIds: groupChat.onlineMemberIds,
    currentUserId: groupChat.currentUserId,
    currentUserLinkId: groupChat.currentUserLinkId ?? null,
    currentUserPrivilege: groupChat.currentUserPrivilege,
    ...(groupChat.onRemoveMember !== undefined && {
      onRemoveMember: groupChat.onRemoveMember,
    }),
    ...(groupChat.onChangePrivilege !== undefined && {
      onChangePrivilege: groupChat.onChangePrivilege,
    }),
    ...(groupChat.onRevokeLinkClick !== undefined && {
      onRevokeLinkClick: groupChat.onRevokeLinkClick,
    }),
    ...(groupChat.onSaveLinkName !== undefined && {
      onSaveLinkName: groupChat.onSaveLinkName,
    }),
    ...(groupChat.onChangeLinkPrivilege !== undefined && {
      onChangeLinkPrivilege: groupChat.onChangeLinkPrivilege,
    }),
    ...(groupChat.onLeave !== undefined && { onLeaveClick: groupChat.onLeave }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- Required for noop fallback
const NOOP = (): void => {};

interface ForkTabsResolvedProps {
  forks: NonNullable<ChatLayoutProps['forks']>;
  activeForkId: string | null;
  onForkSelect: (forkId: string) => void;
  onRename: (forkId: string, currentName: string) => void;
  onDelete: (forkId: string) => void;
}

interface ForkTabsInput {
  forks: ChatLayoutProps['forks'];
  activeForkId: ChatLayoutProps['activeForkId'];
  onForkSelect: ChatLayoutProps['onForkSelect'];
  onForkRename: ChatLayoutProps['onForkRename'];
  onForkDelete: ChatLayoutProps['onForkDelete'];
}

export function resolveForkTabsProps(input: ForkTabsInput): ForkTabsResolvedProps {
  return {
    forks: input.forks ?? [],
    activeForkId: input.activeForkId ?? null,
    onForkSelect: input.onForkSelect ?? NOOP,
    onRename: input.onForkRename ?? NOOP,
    onDelete: input.onForkDelete ?? NOOP,
  };
}
