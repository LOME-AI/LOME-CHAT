import { describe, it, expect, vi } from 'vitest';
import {
  getMobileInputStyle,
  getContentAreaStyle,
  getWebSocketAttributes,
  resolveChatLayoutDerivedState,
  resolveForkTabsProps,
  buildMemberSidebarProps,
} from '@/components/chat/layout/chat-layout-helpers';
import type { Message } from '@/lib/api';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';

describe('getMobileInputStyle', () => {
  it('returns undefined when not mobile', () => {
    expect(
      getMobileInputStyle({ isMobile: false, keyboardOffset: 10, isKeyboardVisible: true })
    ).toBeUndefined();
  });

  it('returns fixed-position style with keyboard offset when mobile', () => {
    const style = getMobileInputStyle({
      isMobile: true,
      keyboardOffset: 42,
      isKeyboardVisible: false,
    });

    expect(style).toMatchObject({
      position: 'fixed',
      bottom: '42px',
      transition: 'bottom 0.2s ease-out',
      zIndex: 10,
    });
  });

  it('disables transition while the keyboard is visible', () => {
    const style = getMobileInputStyle({
      isMobile: true,
      keyboardOffset: 0,
      isKeyboardVisible: true,
    });

    expect(style?.transition).toBe('none');
  });
});

describe('getContentAreaStyle', () => {
  it('returns a bottom margin equal to the input height on mobile', () => {
    expect(getContentAreaStyle(true, 64)).toEqual({ marginBottom: 64 });
  });

  it('returns undefined on mobile when the input height is zero', () => {
    expect(getContentAreaStyle(true, 0)).toBeUndefined();
  });

  it('returns undefined when not mobile', () => {
    expect(getContentAreaStyle(false, 64)).toBeUndefined();
  });
});

describe('getWebSocketAttributes', () => {
  it('returns "true" for connected and ready when both are true', () => {
    expect(getWebSocketAttributes({ connected: true, ready: true })).toEqual({
      wsConnected: 'true',
      wsReady: 'true',
    });
  });

  it('returns undefined attributes when ws is undefined', () => {
    const noWs: { connected: boolean; ready: boolean } | undefined = undefined;
    expect(getWebSocketAttributes(noWs)).toEqual({
      wsConnected: undefined,
      wsReady: undefined,
    });
  });

  it('returns undefined for a flag that is false', () => {
    expect(getWebSocketAttributes({ connected: false, ready: true })).toEqual({
      wsConnected: undefined,
      wsReady: 'true',
    });
  });
});

describe('resolveChatLayoutDerivedState', () => {
  const baseMessage: Message = {
    id: 'm1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'hello',
    createdAt: '',
  };

  it('passes through premiumIds and resolves canAccessPremium from tierInfo', () => {
    const premiumIds = new Set(['gpt-5']);
    const result = resolveChatLayoutDerivedState({
      premiumIds,
      tierInfo: { canAccessPremium: true },
      shareMessageId: null,
      messages: [],
    });

    expect(result.premiumIds).toBe(premiumIds);
    expect(result.canAccessPremium).toBe(true);
  });

  it('defaults canAccessPremium to false when tierInfo is undefined', () => {
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      tierInfo: undefined,
      shareMessageId: null,
      messages: [],
    });

    expect(result.canAccessPremium).toBe(false);
  });

  it('returns null shared-message fields when shareMessageId is null', () => {
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      tierInfo: undefined,
      shareMessageId: null,
      messages: [baseMessage],
    });

    expect(result.sharedMessageContent).toBeNull();
    expect(result.sharedMessageEpochNumber).toBeNull();
    expect(result.sharedMessageWrappedContentKey).toBeNull();
    expect(result.sharedMessageMediaItems).toBeNull();
  });

  it('extracts shared-message fields when the shared message is found', () => {
    const shared: Message = {
      ...baseMessage,
      id: 'shared',
      content: 'shared content',
      epochNumber: 7,
      wrappedContentKey: 'wrapped-key',
      mediaItems: [],
      senderId: 'sender-42',
    };
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      tierInfo: undefined,
      shareMessageId: 'shared',
      messages: [baseMessage, shared],
    });

    expect(result.sharedMessageContent).toBe('shared content');
    expect(result.sharedMessageEpochNumber).toBe(7);
    expect(result.sharedMessageWrappedContentKey).toBe('wrapped-key');
    expect(result.sharedMessageMediaItems).toEqual([]);
    expect(result.sharedMessageSenderId).toBe('sender-42');
  });

  it('canonicalizes an absent senderId to an empty string', () => {
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      tierInfo: undefined,
      shareMessageId: null,
      messages: [baseMessage],
    });

    expect(result.sharedMessageSenderId).toBe('');
  });

  it('returns null shared-message fields when the id matches no message', () => {
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      tierInfo: undefined,
      shareMessageId: 'missing',
      messages: [baseMessage],
    });

    expect(result.sharedMessageContent).toBeNull();
  });

  it('falls back to null/empty for a found message missing optional fields', () => {
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      tierInfo: undefined,
      shareMessageId: 'm1',
      messages: [baseMessage],
    });

    expect(result.sharedMessageContent).toBe('hello');
    expect(result.sharedMessageEpochNumber).toBeNull();
    expect(result.sharedMessageWrappedContentKey).toBeNull();
    expect(result.sharedMessageMediaItems).toBeNull();
    expect(result.sharedMessageSenderId).toBe('');
  });
});

describe('resolveForkTabsProps', () => {
  it('defaults to an empty fork list and noop callbacks when nothing is provided', () => {
    const resolved = resolveForkTabsProps({
      forks: undefined,
      activeForkId: undefined,
      onForkSelect: undefined,
      onForkRename: undefined,
      onForkDelete: undefined,
    });

    expect(resolved.forks).toEqual([]);
    expect(resolved.activeForkId).toBeNull();
    expect(() => {
      resolved.onForkSelect('x');
      resolved.onRename('x', 'y');
      resolved.onDelete('x');
    }).not.toThrow();
  });

  it('forwards provided forks, activeForkId, and callbacks', () => {
    const onForkSelect = (): void => {};
    const onForkRename = (): void => {};
    const onForkDelete = (): void => {};
    const forks = [
      {
        id: 'f1',
        conversationId: 'c1',
        name: 'Main',
        tipMessageId: null,
        createdAt: '2026-01-01',
      },
    ];

    const resolved = resolveForkTabsProps({
      forks,
      activeForkId: 'f1',
      onForkSelect,
      onForkRename,
      onForkDelete,
    });

    expect(resolved.forks).toBe(forks);
    expect(resolved.activeForkId).toBe('f1');
    expect(resolved.onForkSelect).toBe(onForkSelect);
    expect(resolved.onRename).toBe(onForkRename);
    expect(resolved.onDelete).toBe(onForkDelete);
  });
});

describe('buildMemberSidebarProps', () => {
  function makeGroupChat(overrides: Partial<GroupChatProps> = {}): GroupChatProps {
    return {
      conversationId: 'conv-1',
      members: [{ id: 'm1', userId: 'u1', username: 'a', privilege: 'owner' }],
      links: [],
      onlineMemberIds: new Set(['u1']),
      currentUserId: 'u1',
      currentUserLinkId: null,
      currentUserPrivilege: 'owner',
      currentEpochPrivateKey: new Uint8Array(32),
      currentEpochNumber: 1,
      ...overrides,
    } as GroupChatProps;
  }

  it('returns an empty object when there is no group chat', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- groupChat is a required positional arg
    expect(buildMemberSidebarProps(undefined)).toEqual({});
  });

  it('maps core fields and omits optional callbacks that are absent', () => {
    const result = buildMemberSidebarProps(makeGroupChat());

    expect(result.members).toHaveLength(1);
    expect(result.currentUserId).toBe('u1');
    expect(result.currentUserLinkId).toBeNull();
    expect(result).not.toHaveProperty('onRemoveMember');
    expect(result).not.toHaveProperty('onChangePrivilege');
    expect(result).not.toHaveProperty('onRevokeLinkClick');
    expect(result).not.toHaveProperty('onSaveLinkName');
    expect(result).not.toHaveProperty('onChangeLinkPrivilege');
    expect(result).not.toHaveProperty('onLeaveClick');
  });

  it('forwards every optional callback when the group chat provides them', () => {
    const onRemoveMember = vi.fn();
    const onChangePrivilege = vi.fn();
    const onRevokeLinkClick = vi.fn();
    const onSaveLinkName = vi.fn();
    const onChangeLinkPrivilege = vi.fn();
    const onLeave = vi.fn();

    const result = buildMemberSidebarProps(
      makeGroupChat({
        currentUserLinkId: 'link-9',
        onRemoveMember,
        onChangePrivilege,
        onRevokeLinkClick,
        onSaveLinkName,
        onChangeLinkPrivilege,
        onLeave,
      })
    );

    expect(result.currentUserLinkId).toBe('link-9');
    expect(result.onRemoveMember).toBe(onRemoveMember);
    expect(result.onChangePrivilege).toBe(onChangePrivilege);
    expect(result.onRevokeLinkClick).toBe(onRevokeLinkClick);
    expect(result.onSaveLinkName).toBe(onSaveLinkName);
    expect(result.onChangeLinkPrivilege).toBe(onChangeLinkPrivilege);
    expect(result.onLeaveClick).toBe(onLeave);
  });
});
