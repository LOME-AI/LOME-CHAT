import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import {
  ChatPromptInput,
  buildChatHeaderGroupProps,
} from '@/components/chat/input/chat-prompt-input';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';

let lastPromptProps: Record<string, unknown> = {};

vi.mock('@/components/chat/input/prompt-input', () => ({
  PromptInput: React.forwardRef(function MockPromptInput(
    props: Record<string, unknown>,
    _ref: React.ForwardedRef<unknown>
  ) {
    // eslint-disable-next-line react-hooks/globals -- test mock captures prop for later assertion
    lastPromptProps = props;
    return <div data-testid="prompt-input" />;
  }),
}));

function baseProps(): React.ComponentProps<typeof ChatPromptInput> {
  return {
    promptInputRef: { current: null },
    inputValue: '',
    onInputChange: vi.fn(),
    handleSubmit: vi.fn(),
    historyCharacters: 0,
    inputDisabled: false,
    isProcessing: false,
    isMobile: false,
    conversationId: undefined,
    groupChat: undefined,
    callerPrivilege: undefined,
    handleSubmitUserOnly: vi.fn(),
    handleTypingChange: vi.fn(),
    searchProps: undefined,
    isAuthenticated: true,
    activeModality: 'text',
    onSelectModality: vi.fn(),
  };
}

function makeGroupChat(overrides: Partial<GroupChatProps> = {}): GroupChatProps {
  return {
    conversationId: 'conv-1',
    members: [
      { id: 'm1', userId: 'u1', username: 'a', privilege: 'owner' },
      { id: 'm2', userId: 'u2', username: 'b', privilege: 'write' },
    ],
    links: [],
    onlineMemberIds: new Set<string>(),
    currentUserId: 'u1',
    currentUserLinkId: null,
    currentUserPrivilege: 'owner',
    currentEpochPrivateKey: new Uint8Array(32),
    currentEpochNumber: 1,
    ...overrides,
  } as GroupChatProps;
}

describe('ChatPromptInput', () => {
  beforeEach(() => {
    lastPromptProps = {};
  });

  it('forwards the optional editing, cancel-edit and stop handlers when provided', () => {
    const onCancelEdit = vi.fn();
    const onStop = vi.fn();
    render(
      <ChatPromptInput {...baseProps()} isEditing onCancelEdit={onCancelEdit} onStop={onStop} />
    );

    expect(lastPromptProps['isEditing']).toBe(true);
    expect(lastPromptProps['onCancelEdit']).toBe(onCancelEdit);
    expect(lastPromptProps['onStop']).toBe(onStop);
  });

  it('omits the optional handlers when not provided', () => {
    render(<ChatPromptInput {...baseProps()} />);

    expect(lastPromptProps).not.toHaveProperty('isEditing');
    expect(lastPromptProps).not.toHaveProperty('onCancelEdit');
    expect(lastPromptProps).not.toHaveProperty('onStop');
  });

  it('forwards group-chat props (privilege, group flag, typing, submit-user-only) for a multi-member group', () => {
    const handleSubmitUserOnly = vi.fn();
    const handleTypingChange = vi.fn();
    const ws = { connected: true } as unknown as GroupChatProps['ws'];
    render(
      <ChatPromptInput
        {...baseProps()}
        groupChat={makeGroupChat({ ws })}
        handleSubmitUserOnly={handleSubmitUserOnly}
        handleTypingChange={handleTypingChange}
      />
    );

    expect(lastPromptProps['conversationId']).toBe('conv-1');
    expect(lastPromptProps['currentUserPrivilege']).toBe('owner');
    expect(lastPromptProps['isGroupChat']).toBe(true);
    expect(lastPromptProps['onSubmitUserOnly']).toBe(handleSubmitUserOnly);
    expect(lastPromptProps['onTypingChange']).toBe(handleTypingChange);
  });

  it('does not mark a solo conversation as a group chat and has no typing handler without a socket', () => {
    render(
      <ChatPromptInput
        {...baseProps()}
        groupChat={makeGroupChat({
          members: [{ id: 'm1', userId: 'u1', username: 'a', privilege: 'owner' }],
        })}
      />
    );

    expect(lastPromptProps).not.toHaveProperty('isGroupChat');
    expect(lastPromptProps).not.toHaveProperty('onTypingChange');
  });

  it('falls back to caller-provided conversationId and privilege without a groupChat', () => {
    render(<ChatPromptInput {...baseProps()} conversationId="conv-9" callerPrivilege="read" />);

    expect(lastPromptProps['conversationId']).toBe('conv-9');
    expect(lastPromptProps['currentUserPrivilege']).toBe('read');
  });
});

describe('buildChatHeaderGroupProps', () => {
  it('returns an empty object when there is no group chat', () => {
    expect(buildChatHeaderGroupProps(undefined, vi.fn())).toEqual({});
  });

  it('maps group members and the facepile handler when a group chat is present', () => {
    const onFacepileClick = vi.fn();
    const groupChat = makeGroupChat();

    const result = buildChatHeaderGroupProps(groupChat, onFacepileClick);

    expect(result.members).toBe(groupChat.members);
    expect(result.onlineMemberIds).toBe(groupChat.onlineMemberIds);
    expect(result.onFacepileClick).toBe(onFacepileClick);
  });
});
