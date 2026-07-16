import type * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useInputFocusManagement,
  useStreamScrollEffect,
  useInputHeightObserver,
  useSubmitUserOnly,
  useTypingBroadcast,
} from '@/components/chat/layout/chat-layout-hooks';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';
import type { ConversationWebSocket } from '@/lib/ws-client';
import type { MessageListHandle } from '@/components/chat/message/message-list';
import type { PromptInputRef } from '@/components/chat/input/prompt-input';

/**
 * Replace requestAnimationFrame with a synchronous shim so the double-rAF focus
 * and scroll deferrals run inline within the test, making their effects
 * observable without fake timers.
 */
function stubSyncRaf(): void {
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
    (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }
  );
}

function makePromptRef(focus: () => void): React.RefObject<PromptInputRef | null> {
  return { current: { focus } as PromptInputRef };
}

function makeVirtuosoRef(
  overrides: Partial<MessageListHandle> = {}
): React.RefObject<MessageListHandle | null> {
  return {
    current: {
      scrollToIndex: vi.fn(),
      resetScrollBreakaway: vi.fn(),
      ...overrides,
    } as unknown as MessageListHandle,
  };
}

describe('useInputFocusManagement', () => {
  beforeEach(() => {
    stubSyncRaf();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('focuses the prompt when input transitions from disabled to enabled on desktop', () => {
    const focus = vi.fn();
    const ref = makePromptRef(focus);
    const { rerender } = renderHook(
      ({ disabled }: { disabled: boolean }) => {
        useInputFocusManagement(disabled, false, ref);
      },
      { initialProps: { disabled: true } }
    );

    rerender({ disabled: false });

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not focus on the enable transition when on mobile', () => {
    const focus = vi.fn();
    const ref = makePromptRef(focus);
    const { rerender } = renderHook(
      ({ disabled }: { disabled: boolean }) => {
        useInputFocusManagement(disabled, true, ref);
      },
      { initialProps: { disabled: true } }
    );

    rerender({ disabled: false });

    expect(focus).not.toHaveBeenCalled();
  });

  it('does not focus when input was already enabled (no transition)', () => {
    const focus = vi.fn();
    const ref = makePromptRef(focus);
    renderHook(() => {
      useInputFocusManagement(false, false, ref);
    });

    expect(focus).not.toHaveBeenCalled();
  });
});

describe('useStreamScrollEffect', () => {
  beforeEach(() => {
    stubSyncRaf();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scrolls to last when streaming starts on the first message', () => {
    const ref = makeVirtuosoRef();
    const { rerender } = renderHook(
      ({ ids }: { ids: Set<string> }) => {
        useStreamScrollEffect(ids, 2, ref);
      },
      { initialProps: { ids: new Set<string>() } }
    );

    rerender({ ids: new Set(['m1']) });

    expect(ref.current?.scrollToIndex).toHaveBeenCalledWith({
      index: 'LAST',
      align: 'end',
      behavior: 'smooth',
    });
  });

  it('does not scroll when streaming starts but the conversation is past the first message', () => {
    const ref = makeVirtuosoRef();
    const { rerender } = renderHook(
      ({ ids }: { ids: Set<string> }) => {
        useStreamScrollEffect(ids, 5, ref);
      },
      { initialProps: { ids: new Set<string>() } }
    );

    rerender({ ids: new Set(['m1']) });

    expect(ref.current?.scrollToIndex).not.toHaveBeenCalled();
  });

  it('does not scroll again when streaming continues without a fresh start', () => {
    const ref = makeVirtuosoRef();
    const { rerender } = renderHook(
      ({ ids }: { ids: Set<string> }) => {
        useStreamScrollEffect(ids, 2, ref);
      },
      { initialProps: { ids: new Set<string>() } }
    );

    rerender({ ids: new Set(['m1']) });
    (ref.current?.scrollToIndex as ReturnType<typeof vi.fn>).mockClear();

    rerender({ ids: new Set(['m1', 'm2']) });

    expect(ref.current?.scrollToIndex).not.toHaveBeenCalled();
  });
});

describe('useInputHeightObserver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 and observes nothing when not on mobile', () => {
    const ref = { current: document.createElement('div') };
    const { result } = renderHook(() => useInputHeightObserver(false, ref));

    expect(result.current).toBe(0);
  });

  it('returns 0 when on mobile but the container ref is null', () => {
    const ref = { current: null };
    const { result } = renderHook(() => useInputHeightObserver(true, ref));

    expect(result.current).toBe(0);
  });

  it('measures the container height on mobile and disconnects on unmount', () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'offsetHeight', { value: 128, configurable: true });
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        disconnect = disconnect;
        unobserve = vi.fn();
      }
    );
    const ref = { current: element };

    const { result, unmount } = renderHook(() => useInputHeightObserver(true, ref));

    expect(result.current).toBe(128);
    expect(observe).toHaveBeenCalledWith(element);

    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('re-measures when the ResizeObserver fires', () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'offsetHeight', { value: 40, configurable: true });
    let fire: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          fire = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      }
    );
    const ref = { current: element };

    const { result } = renderHook(() => useInputHeightObserver(true, ref));
    expect(result.current).toBe(40);

    Object.defineProperty(element, 'offsetHeight', { value: 72, configurable: true });
    act(() => {
      fire?.();
    });

    expect(result.current).toBe(72);
  });

  it('skips measuring when the container ref clears before the observer fires', () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'offsetHeight', { value: 55, configurable: true });
    let fire: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          fire = callback;
        }
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      }
    );
    const ref: { current: HTMLDivElement | null } = { current: element };

    const { result } = renderHook(() => useInputHeightObserver(true, ref));
    expect(result.current).toBe(55);

    // Container detaches; the observer callback must not touch a null ref.
    ref.current = null;
    act(() => {
      fire?.();
    });

    expect(result.current).toBe(55);
  });
});

describe('useSubmitUserOnly', () => {
  beforeEach(() => {
    stubSyncRaf();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes the callback, resets breakaway, and scrolls to last', () => {
    const onSubmit = vi.fn();
    const resetScrollBreakaway = vi.fn();
    const scrollToIndex = vi.fn();
    const ref = makeVirtuosoRef({ resetScrollBreakaway, scrollToIndex });

    const { result } = renderHook(() => useSubmitUserOnly(onSubmit, ref));
    result.current();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(resetScrollBreakaway).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior: 'smooth' });
  });

  it('is a no-op when no submit callback is provided', () => {
    const ref = makeVirtuosoRef();
    const { result } = renderHook(() =>
      useSubmitUserOnly(undefined as unknown as (() => void) | undefined, ref)
    );

    result.current();

    expect(ref.current?.resetScrollBreakaway).not.toHaveBeenCalled();
  });
});

describe('useTypingBroadcast', () => {
  function makeGroupChat(overrides: Partial<GroupChatProps>): GroupChatProps {
    return {
      conversationId: 'conv-1',
      members: [],
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

  it('sends typing:start when broadcasting true over a connected socket', () => {
    const send = vi.fn();
    const ws = { send, connected: true } as unknown as ConversationWebSocket;
    const { result } = renderHook(() =>
      useTypingBroadcast(makeGroupChat({ ws, currentUserId: 'u1' }))
    );

    result.current(true);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'typing:start', conversationId: 'conv-1', userId: 'u1' })
    );
  });

  it('sends typing:stop when broadcasting false', () => {
    const send = vi.fn();
    const ws = { send, connected: true } as unknown as ConversationWebSocket;
    const { result } = renderHook(() => useTypingBroadcast(makeGroupChat({ ws })));

    result.current(false);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'typing:stop' }));
  });

  it('does nothing when there is no groupChat', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- groupChat is a required positional arg
    const { result } = renderHook(() => useTypingBroadcast(undefined));
    expect(() => {
      result.current(true);
    }).not.toThrow();
  });

  it('does nothing when the socket is disconnected', () => {
    const send = vi.fn();
    const ws = { send, connected: false } as unknown as ConversationWebSocket;
    const { result } = renderHook(() => useTypingBroadcast(makeGroupChat({ ws })));

    result.current(true);

    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when there is no current user id', () => {
    const send = vi.fn();
    const ws = { send, connected: true } as unknown as ConversationWebSocket;
    const { result } = renderHook(() =>
      useTypingBroadcast(makeGroupChat({ ws, currentUserId: undefined as unknown as string }))
    );

    result.current(true);

    expect(send).not.toHaveBeenCalled();
  });
});
