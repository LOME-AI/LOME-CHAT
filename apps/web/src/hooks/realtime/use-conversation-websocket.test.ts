import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAcquire = vi.fn();
const mockRelease = vi.fn();

interface FakeRegistrySocket {
  onStateChange: (listener: () => void) => () => void;
  fireStateChange: () => void;
  stateListenerCount: () => number;
}

function createFakeSocket(): FakeRegistrySocket {
  const listeners = new Set<() => void>();
  return {
    onStateChange(listener) {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    fireStateChange(): void {
      for (const listener of listeners) listener();
    },
    stateListenerCount: () => listeners.size,
  };
}

vi.mock('@/lib/conversation-socket-registry.js', () => ({
  acquireConversationSocket: (id: string): unknown => mockAcquire(id) as unknown,
  releaseConversationSocket: (id: string): void => {
    mockRelease(id);
  },
}));

import { useConversationWebSocket } from '@/hooks/realtime/use-conversation-websocket.js';

describe('useConversationWebSocket', () => {
  let socket: FakeRegistrySocket;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = createFakeSocket();
    mockAcquire.mockImplementation(() => socket);
  });

  it('returns null when conversationId is null', () => {
    const { result } = renderHook(() => useConversationWebSocket(null));

    expect(result.current).toBeNull();
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('acquires the shared socket for the conversation', () => {
    const { result } = renderHook(() => useConversationWebSocket('conv-123'));

    expect(mockAcquire).toHaveBeenCalledWith('conv-123');
    expect(result.current).toBe(socket as unknown);
  });

  it('releases the previous socket when conversationId changes', () => {
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) => useConversationWebSocket(id),
      { initialProps: { id: 'conv-1' } }
    );

    rerender({ id: 'conv-2' });

    expect(mockRelease).toHaveBeenCalledWith('conv-1');
    expect(mockAcquire).toHaveBeenCalledWith('conv-2');
  });

  it('releases on unmount and unsubscribes state changes', () => {
    const { unmount } = renderHook(() => useConversationWebSocket('conv-123'));
    expect(socket.stateListenerCount()).toBe(1);

    unmount();

    expect(mockRelease).toHaveBeenCalledWith('conv-123');
    expect(socket.stateListenerCount()).toBe(0);
  });

  it('does not acquire for an empty string conversationId', () => {
    const { result } = renderHook(() => useConversationWebSocket(''));

    expect(result.current).toBeNull();
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('rerenders on socket state changes (ready/connected flips)', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useConversationWebSocket('conv-123');
    });
    const before = renders;

    act(() => {
      socket.fireStateChange();
    });

    expect(renders).toBeGreaterThan(before);
  });
});
