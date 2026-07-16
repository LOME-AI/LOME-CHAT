import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTypingIndicators } from '@/hooks/realtime/use-typing-indicators.js';
import type { ConversationWebSocket } from '@/lib/ws-client.js';

interface MockWs {
  on: ReturnType<typeof vi.fn>;
  listeners: Map<string, Set<(event: unknown) => void>>;
  emit: (type: string, event: unknown) => void;
}

function createMockWs(): MockWs {
  const listeners = new Map<string, Set<(event: unknown) => void>>();

  const on = vi.fn((type: string, handler: (event: unknown) => void) => {
    if (!listeners.has(type)) {
      listeners.set(type, new Set());
    }
    const set = listeners.get(type);
    if (set) set.add(handler);

    return (): void => {
      listeners.get(type)?.delete(handler);
    };
  });

  return {
    on,
    listeners,
    emit: (type: string, event: unknown): void => {
      const set = listeners.get(type);
      if (set) {
        for (const handler of set) {
          handler(event);
        }
      }
    },
  };
}

describe('useTypingIndicators', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty set with null ws', () => {
    const { result } = renderHook(() => useTypingIndicators(null));

    expect(result.current).toBeInstanceOf(Set);
    expect(result.current.size).toBe(0);
  });

  it('adds userId to set on typing:start', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useTypingIndicators(mockWs as unknown as ConversationWebSocket)
    );

    expect(result.current.size).toBe(0);

    act(() => {
      mockWs.emit('typing:start', {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });
    });

    expect(result.current.size).toBe(1);
    expect(result.current.has('user-1')).toBe(true);
  });

  it('removes userId from set on typing:stop', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useTypingIndicators(mockWs as unknown as ConversationWebSocket)
    );

    act(() => {
      mockWs.emit('typing:start', {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });
    });

    expect(result.current.has('user-1')).toBe(true);

    act(() => {
      mockWs.emit('typing:stop', {
        type: 'typing:stop',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });
    });

    expect(result.current.has('user-1')).toBe(false);
    expect(result.current.size).toBe(0);
  });

  it('ignores typing:stop for a user with no active typing timeout', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useTypingIndicators(mockWs as unknown as ConversationWebSocket)
    );

    // No prior typing:start for this user, so there is no timeout to clear —
    // the hook must still resolve to an empty set without throwing.
    act(() => {
      mockWs.emit('typing:stop', {
        type: 'typing:stop',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'ghost',
      });
    });

    expect(result.current.has('ghost')).toBe(false);
    expect(result.current.size).toBe(0);
  });

  it('auto-removes userId after 5 seconds', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useTypingIndicators(mockWs as unknown as ConversationWebSocket)
    );

    act(() => {
      mockWs.emit('typing:start', {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });
    });

    expect(result.current.has('user-1')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(4999);
    });

    expect(result.current.has('user-1')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(result.current.has('user-1')).toBe(false);
    expect(result.current.size).toBe(0);
  });

  it('tracks multiple users independently', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useTypingIndicators(mockWs as unknown as ConversationWebSocket)
    );

    act(() => {
      mockWs.emit('typing:start', {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });
    });

    act(() => {
      mockWs.emit('typing:start', {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-2',
      });
    });

    expect(result.current.size).toBe(2);
    expect(result.current.has('user-1')).toBe(true);
    expect(result.current.has('user-2')).toBe(true);

    act(() => {
      mockWs.emit('typing:stop', {
        type: 'typing:stop',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });
    });

    expect(result.current.size).toBe(1);
    expect(result.current.has('user-1')).toBe(false);
    expect(result.current.has('user-2')).toBe(true);
  });

  it('resets timeout on repeated typing:start for same user', () => {
    const mockWs = createMockWs();

    const { result } = renderHook(() =>
      useTypingIndicators(mockWs as unknown as ConversationWebSocket)
    );

    act(() => {
      mockWs.emit('typing:start', {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });
    });

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.has('user-1')).toBe(true);

    // Second typing:start — resets the 5s timer
    act(() => {
      mockWs.emit('typing:start', {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });
    });

    // Advance another 3 seconds (6s total from first, 3s from second)
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    // Should still be typing because the timer was reset
    expect(result.current.has('user-1')).toBe(true);

    // Advance 2 more seconds (5s from second typing:start)
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.has('user-1')).toBe(false);
  });

  it('removes listeners on unmount', () => {
    const mockWs = createMockWs();

    const { unmount } = renderHook(() =>
      useTypingIndicators(mockWs as unknown as ConversationWebSocket)
    );

    expect(mockWs.on).toHaveBeenCalledTimes(2);
    expect(mockWs.on).toHaveBeenCalledWith('typing:start', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('typing:stop', expect.any(Function));

    const startListeners = mockWs.listeners.get('typing:start');
    const stopListeners = mockWs.listeners.get('typing:stop');
    expect(startListeners?.size).toBe(1);
    expect(stopListeners?.size).toBe(1);

    unmount();

    expect(startListeners?.size).toBe(0);
    expect(stopListeners?.size).toBe(0);
  });

  it('clears timeouts on unmount', () => {
    const mockWs = createMockWs();

    const { result, unmount } = renderHook(() =>
      useTypingIndicators(mockWs as unknown as ConversationWebSocket)
    );

    act(() => {
      mockWs.emit('typing:start', {
        type: 'typing:start',
        timestamp: Date.now(),
        conversationId: 'conv-1',
        userId: 'user-1',
      });
    });

    expect(result.current.has('user-1')).toBe(true);

    unmount();

    // Advance timers past the timeout — should not cause errors
    // (timeouts were cleared on unmount)
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // If timeouts were not cleared, setState would be called after unmount
    // which would cause a warning. The test passing without warnings confirms cleanup.
  });
});
