import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatPageState } from '@/hooks/chat/use-chat-page';
import { useStreamCycleActivityStore } from '@/stores/stream-cycle-activity';

describe('useChatPageState', () => {
  describe('input state', () => {
    it('starts with empty input value', () => {
      const { result } = renderHook(() => useChatPageState());

      expect(result.current.inputValue).toBe('');
    });

    it('updates input value', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.setInputValue('Hello world');
      });

      expect(result.current.inputValue).toBe('Hello world');
    });

    it('clears input value', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.setInputValue('Some text');
      });
      act(() => {
        result.current.clearInput();
      });

      expect(result.current.inputValue).toBe('');
    });
  });

  describe('streaming state', () => {
    it('starts with no streaming messages', () => {
      const { result } = renderHook(() => useChatPageState());

      expect(result.current.streamingMessageIds.size).toBe(0);
      expect(result.current.streamingMessageIdsRef.current.size).toBe(0);
    });

    it('starts streaming with a single message ID', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-123']);
      });

      expect(result.current.streamingMessageIds.has('msg-123')).toBe(true);
      expect(result.current.streamingMessageIds.size).toBe(1);
      expect(result.current.streamingMessageIdsRef.current.has('msg-123')).toBe(true);
    });

    it('starts streaming with multiple message IDs', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-1', 'msg-2', 'msg-3']);
      });

      expect(result.current.streamingMessageIds.size).toBe(3);
      expect(result.current.streamingMessageIds.has('msg-1')).toBe(true);
      expect(result.current.streamingMessageIds.has('msg-2')).toBe(true);
      expect(result.current.streamingMessageIds.has('msg-3')).toBe(true);
    });

    it('does not arm the stream-cycle flag when given no message IDs', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming([]);
      });

      // An empty batch skips the `messageIds.length > 0` guard, so nothing is
      // added to either set.
      expect(result.current.streamingMessageIds.size).toBe(0);
      expect(result.current.persistingMessageIds.size).toBe(0);
    });

    it('stops streaming', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-123']);
      });
      act(() => {
        result.current.stopStreaming(['msg-123']);
      });

      expect(result.current.streamingMessageIds.size).toBe(0);
      expect(result.current.streamingMessageIdsRef.current.size).toBe(0);
    });

    it('ref is updated synchronously with startStreaming', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-456']);
        expect(result.current.streamingMessageIdsRef.current.has('msg-456')).toBe(true);
      });
    });
  });

  // Dual-state lets the UX-driving streamingMessageIds clear on the early
  // model:done flip (so the input re-enables instantly) while a parallel
  // persistingMessageIds set stays populated until the SSE `done` event —
  // i.e. until the server has actually committed the turn. Tests gate on
  // persistingMessageIds for correctness; UI gates on streamingMessageIds
  // for responsiveness.
  describe('persistence state', () => {
    it('starts with no persisting messages', () => {
      const { result } = renderHook(() => useChatPageState());

      expect(result.current.persistingMessageIds.size).toBe(0);
      expect(result.current.persistingMessageIdsRef.current.size).toBe(0);
    });

    it('startStreaming populates persistingMessageIds with the same IDs', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-1', 'msg-2']);
      });

      expect(result.current.persistingMessageIds.size).toBe(2);
      expect(result.current.persistingMessageIds.has('msg-1')).toBe(true);
      expect(result.current.persistingMessageIds.has('msg-2')).toBe(true);
      expect(result.current.persistingMessageIdsRef.current.has('msg-1')).toBe(true);
    });

    it('stopStreaming does NOT clear persistingMessageIds', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-1']);
      });
      act(() => {
        result.current.stopStreaming(['msg-1']);
      });

      expect(result.current.streamingMessageIds.size).toBe(0);
      expect(result.current.persistingMessageIds.size).toBe(1);
      expect(result.current.persistingMessageIds.has('msg-1')).toBe(true);
    });

    it('stopPersisting clears only persistingMessageIds', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-1']);
      });
      act(() => {
        result.current.stopPersisting(['msg-1']);
      });

      expect(result.current.streamingMessageIds.size).toBe(1);
      expect(result.current.persistingMessageIds.size).toBe(0);
      expect(result.current.persistingMessageIdsRef.current.size).toBe(0);
    });

    it('stopStreaming followed by stopPersisting clears both', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-1']);
      });
      act(() => {
        result.current.stopStreaming(['msg-1']);
      });
      act(() => {
        result.current.stopPersisting(['msg-1']);
      });

      expect(result.current.streamingMessageIds.size).toBe(0);
      expect(result.current.persistingMessageIds.size).toBe(0);
    });

    it('persistingMessageIds ref is updated synchronously with startStreaming', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-789']);
        expect(result.current.persistingMessageIdsRef.current.has('msg-789')).toBe(true);
      });
    });
  });

  // Overlapping sends: the input re-enables on the early model:done flip
  // (before the SSE `done`), so a user can fire turn N+1 while turn N is still
  // settling cost/persistence. Turn N's later `done` must only release turn
  // N's own ids — never the in-flight turn N+1's. These cover the multi-model
  // case (N tiles per turn) since a turn tracks every tile id as a group.
  describe('concurrent turns (overlapping sends)', () => {
    it('startStreaming adds ids without evicting a still-active turn (multi-model)', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['A1', 'A2']);
      });
      act(() => {
        result.current.startStreaming(['B1', 'B2']);
      });

      for (const id of ['A1', 'A2', 'B1', 'B2']) {
        expect(result.current.persistingMessageIds.has(id)).toBe(true);
      }
      expect(result.current.persistingMessageIds.size).toBe(4);
    });

    it('stopPersisting releases only the named turn, leaving a concurrent turn intact (multi-model)', () => {
      const { result } = renderHook(() => useChatPageState());

      // Turn N (2 models) streams, then reaches its model:done flip.
      act(() => {
        result.current.startStreaming(['A1', 'A2']);
      });
      act(() => {
        result.current.stopStreaming(['A1', 'A2']);
      });
      // User sends turn N+1 (2 models) during N's cost-settling window.
      act(() => {
        result.current.startStreaming(['B1', 'B2']);
      });
      // Turn N's SSE `done` finally arrives.
      act(() => {
        result.current.stopPersisting(['A1', 'A2']);
      });

      // N+1 is still persisting; its tiles must survive N's late `done`.
      expect(result.current.persistingMessageIds.has('B1')).toBe(true);
      expect(result.current.persistingMessageIds.has('B2')).toBe(true);
      expect(result.current.persistingMessageIds.has('A1')).toBe(false);
      expect(result.current.persistingMessageIds.has('A2')).toBe(false);
      expect(result.current.persistingMessageIds.size).toBe(2);
    });

    it('stopStreaming releases only the named turn, leaving a concurrent turn streaming', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['A1']);
      });
      act(() => {
        result.current.startStreaming(['B1']);
      });
      act(() => {
        result.current.stopStreaming(['A1']);
      });

      expect(result.current.streamingMessageIds.has('A1')).toBe(false);
      expect(result.current.streamingMessageIds.has('B1')).toBe(true);
      expect(result.current.streamingMessageIds.size).toBe(1);
    });
  });

  describe('callback stability', () => {
    it('maintains stable callback references', () => {
      const { result, rerender } = renderHook(() => useChatPageState());

      const initialClearInput = result.current.clearInput;
      const initialStartStreaming = result.current.startStreaming;
      const initialStopStreaming = result.current.stopStreaming;
      const initialStopPersisting = result.current.stopPersisting;

      rerender();

      expect(result.current.clearInput).toBe(initialClearInput);
      expect(result.current.startStreaming).toBe(initialStartStreaming);
      expect(result.current.stopStreaming).toBe(initialStopStreaming);
      expect(result.current.stopPersisting).toBe(initialStopPersisting);
    });
  });

  describe('stream-cycle completion signal', () => {
    beforeEach(() => {
      useStreamCycleActivityStore.setState({ streamsCompleted: 0 });
    });

    it('marks a stream cycle complete when persisting drains to empty', () => {
      const { result } = renderHook(() => useChatPageState());
      act(() => {
        result.current.startStreaming(['m1']);
      });
      expect(useStreamCycleActivityStore.getState().streamsCompleted).toBe(0);
      act(() => {
        result.current.stopPersisting(['m1']);
      });
      expect(useStreamCycleActivityStore.getState().streamsCompleted).toBe(1);
    });

    it('marks the cycle complete even when start and stop land in one render batch', () => {
      const { result } = renderHook(() => useChatPageState());
      act(() => {
        result.current.startStreaming(['m1']);
        result.current.stopPersisting(['m1']);
      });
      expect(useStreamCycleActivityStore.getState().streamsCompleted).toBe(1);
    });

    it('does not mark a cycle complete on a stopPersisting with no active stream', () => {
      const { result } = renderHook(() => useChatPageState());
      act(() => {
        result.current.stopPersisting(['m1']);
      });
      expect(useStreamCycleActivityStore.getState().streamsCompleted).toBe(0);
    });
  });
});
