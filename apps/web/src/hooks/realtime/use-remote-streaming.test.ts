import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRemoteStreaming } from '@/hooks/realtime/use-remote-streaming.js';
import {
  markPendingLocalRun,
  resolvePendingLocalRun,
  resetRunOwnershipForTests,
} from '@/lib/run-ownership.js';
import type { RunFrame } from '@/lib/server-frames.js';
import type { ConversationWebSocket } from '@/lib/ws-client.js';

interface MockWs {
  conversationId: string;
  onRunFrame: (listener: (frame: RunFrame) => void) => () => void;
  emit: (frame: RunFrame) => void;
  listenerCount: () => number;
}

function createMockWs(conversationId = 'conv-1'): MockWs {
  const listeners = new Set<(frame: RunFrame) => void>();
  return {
    conversationId,
    onRunFrame(listener) {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    emit(frame) {
      for (const listener of listeners) listener(frame);
    },
    listenerCount: () => listeners.size,
  };
}

const asWs = (mock: MockWs): ConversationWebSocket => mock as unknown as ConversationWebSocket;

function stream(streamId: string, cursor: number, event: unknown): RunFrame {
  return { type: 'stream', streamId, cursor, event } as RunFrame;
}

describe('useRemoteStreaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunOwnershipForTests();
  });

  it('returns an empty map with null ws', () => {
    const { result } = renderHook(() => useRemoteStreaming(null));
    expect(result.current).toBeInstanceOf(Map);
    expect(result.current.size).toBe(0);
  });

  it('renders a remote run as phantom tiles labeled by stream-start', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)));

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'Hel' }));
      ws.emit(stream('s1', 3, { kind: 'text-delta', index: 0, content: 'lo' }));
    });

    expect(result.current.get('s1')).toEqual({
      content: 'Hello',
      senderType: 'ai',
      modelName: 'model-x',
    });
  });

  it('renders multiple remote streams independently', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)));

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
      ws.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'model-b' }));
      ws.emit(stream('s2', 2, { kind: 'text-delta', index: 0, content: 'B' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'A' }));
    });

    expect(result.current.get('s1')?.content).toBe('A');
    expect(result.current.get('s2')?.content).toBe('B');
  });

  it('ignores frames of a locally-owned run', () => {
    markPendingLocalRun('conv-1');
    resolvePendingLocalRun('conv-1', 'local-run');
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)));

    act(() => {
      ws.emit({ type: 'run-started', runId: 'local-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'mine' }));
    });

    expect(result.current.size).toBe(0);
  });

  it('treats frames as local while a local POST is pending (pre-201 window)', () => {
    markPendingLocalRun('conv-1');
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)));

    act(() => {
      ws.emit({ type: 'run-started', runId: 'not-yet-resolved' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
    });

    expect(result.current.size).toBe(0);
  });

  it('drops stream frames arriving without a run-started verdict', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)));

    act(() => {
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'orphan' }));
    });

    expect(result.current.size).toBe(0);
  });

  it('clears phantoms when the run finishes (refetch renders persisted rows)', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)));

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'hi' }));
    });
    expect(result.current.size).toBe(1);

    act(() => {
      ws.emit({
        type: 'run-finished',
        runId: 'remote-run',
        outcome: { outcome: 'succeeded' },
      } as RunFrame);
    });
    expect(result.current.size).toBe(0);
  });

  it('ignores non-text inference events without crashing', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)));

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'reasoning-delta', index: 0, content: 'hmm' }));
      ws.emit(stream('s1', 3, { kind: 'tool-call', id: 't', name: 'search', args: {} }));
      ws.emit(
        stream('s1', 4, {
          kind: 'finish',
          metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
        })
      );
    });

    expect(result.current.get('s1')?.content).toBe('');
  });

  it('creates an unlabeled phantom for a text-delta with no preceding stream-start', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)));

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      // text-delta for a stream that never announced its model: the fallback
      // else-branch creates the phantom with no modelName.
      ws.emit(stream('s9', 1, { kind: 'text-delta', index: 0, content: 'raw' }));
    });

    expect(result.current.get('s9')).toEqual({
      content: 'raw',
      senderType: 'ai',
    });
    expect(result.current.get('s9')).not.toHaveProperty('modelName');
  });

  it('unsubscribes on unmount', () => {
    const ws = createMockWs();
    const { unmount } = renderHook(() => useRemoteStreaming(asWs(ws)));
    expect(ws.listenerCount()).toBe(1);
    unmount();
    expect(ws.listenerCount()).toBe(0);
  });
});
