import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useConversationActivity } from '@/hooks/notifications/use-conversation-activity';
import { useNotificationActivityStore } from '@/stores/notification-activity';
import type { ConversationWebSocket } from '@/lib/ws-client';

const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';
const CALLER_ID = 'user-1';

type Listener = (event: { conversationId: string; senderId?: string }) => void;

function fakeSocket(): {
  socket: ConversationWebSocket;
  emit: (event: { conversationId: string; senderId?: string }) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  const listeners: Listener[] = [];
  const unsubscribe = vi.fn();
  const socket = {
    on: vi.fn((type: string, listener: Listener) => {
      if (type === 'message:new') listeners.push(listener);
      return unsubscribe;
    }),
  } as unknown as ConversationWebSocket;
  return {
    socket,
    emit: (event) => {
      act(() => {
        for (const listener of listeners) listener(event);
      });
    },
    unsubscribe,
  };
}

function unreadCount(): number {
  return useNotificationActivityStore.getState().unreadCount;
}

describe('useConversationActivity', () => {
  beforeEach(() => {
    useNotificationActivityStore.setState({ unreadCount: 0 });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  });

  it('counts a message another member sent while the user was away', () => {
    const ws = fakeSocket();
    renderHook(() => {
      useConversationActivity(ws.socket, CALLER_ID);
    });

    ws.emit({ conversationId: CONVERSATION_ID, senderId: 'user-2' });

    expect(unreadCount()).toBe(1);
  });

  it('never counts this user own message coming back over the socket', () => {
    const ws = fakeSocket();
    renderHook(() => {
      useConversationActivity(ws.socket, CALLER_ID);
    });

    ws.emit({ conversationId: CONVERSATION_ID, senderId: CALLER_ID });

    expect(unreadCount()).toBe(0);
  });

  it('counts an assistant message that carries no sender', () => {
    const ws = fakeSocket();
    renderHook(() => {
      useConversationActivity(ws.socket, CALLER_ID);
    });

    ws.emit({ conversationId: CONVERSATION_ID });

    expect(unreadCount()).toBe(1);
  });

  it('subscribes to nothing without a socket', () => {
    expect(() => {
      renderHook(() => {
        useConversationActivity(null, CALLER_ID);
      });
    }).not.toThrow();
  });

  it('unsubscribes when the conversation closes', () => {
    const ws = fakeSocket();
    const { unmount } = renderHook(() => {
      useConversationActivity(ws.socket, CALLER_ID);
    });

    unmount();

    expect(ws.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
