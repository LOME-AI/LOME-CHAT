import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { parseReasoningText } from '@hushbox/shared';
import { useOptimisticMessages } from '@/hooks/chat/use-optimistic-messages';
import type { Message } from '@/lib/api';

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'Hello',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('useOptimisticMessages', () => {
  it('starts with empty messages', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    expect(result.current.optimisticMessages).toEqual([]);
  });

  it('adds a message', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    const message = createMessage();

    act(() => {
      result.current.addOptimisticMessage(message);
    });

    expect(result.current.optimisticMessages).toHaveLength(1);
    expect(result.current.optimisticMessages[0]).toEqual(message);
  });

  it('removes a message by id', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    const msg1 = createMessage({ id: 'msg-1' });
    const msg2 = createMessage({ id: 'msg-2' });

    act(() => {
      result.current.addOptimisticMessage(msg1);
      result.current.addOptimisticMessage(msg2);
    });

    act(() => {
      result.current.removeOptimisticMessage('msg-1');
    });

    expect(result.current.optimisticMessages).toHaveLength(1);
    expect(result.current.optimisticMessages[0]!.id).toBe('msg-2');
  });

  it('appends token to message content', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    const message = createMessage({ content: 'Hello' });

    act(() => {
      result.current.addOptimisticMessage(message);
    });

    act(() => {
      result.current.updateOptimisticMessageContent('msg-1', ' world');
    });

    expect(result.current.optimisticMessages[0]!.content).toBe('Hello world');
  });

  it('appends a token only to the matching message, leaving others unchanged', () => {
    const { result } = renderHook(() => useOptimisticMessages());

    act(() => {
      result.current.addOptimisticMessage(createMessage({ id: 'msg-1', content: 'A' }));
      result.current.addOptimisticMessage(createMessage({ id: 'msg-2', content: 'B' }));
    });

    act(() => {
      result.current.updateOptimisticMessageContent('msg-1', 'X');
    });

    expect(result.current.optimisticMessages[0]!.content).toBe('AX');
    expect(result.current.optimisticMessages[1]!.content).toBe('B');
  });

  it('folds a reasoning-channel token into the parseable reasoning block', () => {
    const { result } = renderHook(() => useOptimisticMessages());

    act(() => {
      result.current.addOptimisticMessage(createMessage({ id: 'msg-1', content: '' }));
    });

    act(() => {
      result.current.updateOptimisticMessageContent('msg-1', 'pondering', 'reasoning');
      result.current.updateOptimisticMessageContent('msg-1', 'answer');
    });

    expect(parseReasoningText(result.current.optimisticMessages[0]!.content)).toEqual({
      reasoning: 'pondering',
      answer: 'answer',
    });
  });

  it('sets errorCode and clears content on matching message', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    const message = createMessage({ content: 'partial response' });

    act(() => {
      result.current.addOptimisticMessage(message);
    });

    act(() => {
      result.current.setOptimisticMessageError('msg-1', 'STREAM_ERROR');
    });

    expect(result.current.optimisticMessages[0]!.errorCode).toBe('STREAM_ERROR');
    expect(result.current.optimisticMessages[0]!.content).toBe('');
  });

  it('does not affect other messages when setting error', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    const msg1 = createMessage({ id: 'msg-1', content: 'OK response' });
    const msg2 = createMessage({ id: 'msg-2', content: 'will fail' });

    act(() => {
      result.current.addOptimisticMessage(msg1);
      result.current.addOptimisticMessage(msg2);
    });

    act(() => {
      result.current.setOptimisticMessageError('msg-2', 'MODEL_ERROR');
    });

    expect(result.current.optimisticMessages[0]!.content).toBe('OK response');
    expect(result.current.optimisticMessages[0]!.errorCode).toBeUndefined();
    expect(result.current.optimisticMessages[1]!.errorCode).toBe('MODEL_ERROR');
    expect(result.current.optimisticMessages[1]!.content).toBe('');
  });

  it('clears one message content for a clean re-execution', () => {
    const { result } = renderHook(() => useOptimisticMessages());

    act(() => {
      result.current.addOptimisticMessage(createMessage({ id: 'msg-1', content: 'partial' }));
      result.current.addOptimisticMessage(createMessage({ id: 'msg-2', content: 'keep' }));
    });

    act(() => {
      result.current.resetOptimisticMessageContent('msg-1');
    });

    expect(result.current.optimisticMessages[0]?.content).toBe('');
    expect(result.current.optimisticMessages[1]?.content).toBe('keep');
  });

  it('resets all messages', () => {
    const { result } = renderHook(() => useOptimisticMessages());

    act(() => {
      result.current.addOptimisticMessage(createMessage({ id: 'msg-1' }));
      result.current.addOptimisticMessage(createMessage({ id: 'msg-2' }));
    });

    act(() => {
      result.current.resetOptimisticMessages();
    });

    expect(result.current.optimisticMessages).toEqual([]);
  });

  describe('pre-inference stage state', () => {
    it('marks a message as classifying when a stage starts', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-smart' }));
      });

      act(() => {
        result.current.setOptimisticMessageStageStart('msg-smart', 'smart-model');
      });

      expect(result.current.optimisticMessages[0]!.classifyingStageId).toBe('smart-model');
      expect(result.current.optimisticMessages[0]!.resolvedModelName).toBeUndefined();
    });

    it('does not affect other messages when one starts a stage', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-explicit' }));
        result.current.addOptimisticMessage(createMessage({ id: 'msg-smart' }));
      });

      act(() => {
        result.current.setOptimisticMessageStageStart('msg-smart', 'smart-model');
      });

      expect(result.current.optimisticMessages[0]!.classifyingStageId).toBeUndefined();
      expect(result.current.optimisticMessages[1]!.classifyingStageId).toBe('smart-model');
    });

    it('clears classifyingStageId and records resolution on stage:done for smart-model', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-smart' }));
        result.current.setOptimisticMessageStageStart('msg-smart', 'smart-model');
      });

      act(() => {
        result.current.setOptimisticMessageStageDone('msg-smart', {
          stageId: 'smart-model',
          resolvedModelId: 'anthropic/claude-opus-4.6',
          resolvedModelName: 'Claude Opus 4.6',
        });
      });

      const msg = result.current.optimisticMessages[0]!;
      expect(msg.classifyingStageId).toBeUndefined();
      expect(msg.resolvedModelName).toBe('Claude Opus 4.6');
      expect(msg.modelName).toBe('anthropic/claude-opus-4.6');
      expect(msg.isSmartModel).toBe(true);
    });

    it('clears classifyingStageId and records errorCode on stage:error', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-smart' }));
        result.current.setOptimisticMessageStageStart('msg-smart', 'smart-model');
      });

      act(() => {
        result.current.setOptimisticMessageStageError('msg-smart', 'NETWORK_ERROR');
      });

      const msg = result.current.optimisticMessages[0]!;
      expect(msg.classifyingStageId).toBeUndefined();
      expect(msg.errorCode).toBe('NETWORK_ERROR');
      expect(msg.content).toBe('');
    });

    it('leaves other messages untouched when one finishes a stage', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-explicit' }));
        result.current.addOptimisticMessage(createMessage({ id: 'msg-smart' }));
        result.current.setOptimisticMessageStageStart('msg-smart', 'smart-model');
      });

      act(() => {
        result.current.setOptimisticMessageStageDone('msg-smart', {
          stageId: 'smart-model',
          resolvedModelId: 'm/r',
          resolvedModelName: 'Resolved',
        });
      });

      const explicit = result.current.optimisticMessages[0]!;
      expect(explicit.modelName).toBeUndefined();
      expect(explicit.resolvedModelName).toBeUndefined();
      expect(explicit.isSmartModel).toBeUndefined();
    });

    it('does not light the Smart chip for a non-smart-model stage resolution', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-explicit' }));
        result.current.setOptimisticMessageStageStart('msg-explicit', 'smart-model');
      });

      act(() => {
        result.current.setOptimisticMessageStageDone('msg-explicit', {
          stageId: 'some-future-stage' as never,
          resolvedModelId: 'm/r',
          resolvedModelName: 'Resolved',
        });
      });

      const msg = result.current.optimisticMessages[0]!;
      expect(msg.modelName).toBe('m/r');
      expect(msg.isSmartModel).toBeUndefined();
    });

    it('leaves other messages untouched when one records a stage error', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-explicit', content: 'keep' }));
        result.current.addOptimisticMessage(createMessage({ id: 'msg-smart' }));
        result.current.setOptimisticMessageStageStart('msg-smart', 'smart-model');
      });

      act(() => {
        result.current.setOptimisticMessageStageError('msg-smart', 'NETWORK_ERROR');
      });

      const untouched = result.current.optimisticMessages[0]!;
      expect(untouched.content).toBe('keep');
      expect(untouched.errorCode).toBeUndefined();
    });
  });

  describe('media-in-flight state', () => {
    it('records mediaInFlight on the matching message when media generation starts', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-image' }));
      });

      act(() => {
        result.current.setOptimisticMessageMediaStart('msg-image', 'image', 'image/png');
      });

      const msg = result.current.optimisticMessages[0]!;
      expect(msg.mediaInFlight).toEqual({ mediaType: 'image', mimeType: 'image/png' });
    });

    it('overwrites mediaInFlight on the second emit (real mime replaces placeholder)', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-image' }));
      });

      act(() => {
        result.current.setOptimisticMessageMediaStart(
          'msg-image',
          'image',
          'application/octet-stream'
        );
      });
      act(() => {
        result.current.setOptimisticMessageMediaStart('msg-image', 'image', 'image/png');
      });

      const msg = result.current.optimisticMessages[0]!;
      expect(msg.mediaInFlight).toEqual({ mediaType: 'image', mimeType: 'image/png' });
    });

    it('records the requested aspectRatio on mediaInFlight when provided', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-image' }));
      });

      act(() => {
        result.current.setOptimisticMessageMediaStart('msg-image', 'image', 'image/png', '16:9');
      });

      const msg = result.current.optimisticMessages[0]!;
      expect(msg.mediaInFlight).toEqual({
        mediaType: 'image',
        mimeType: 'image/png',
        aspectRatio: '16:9',
      });
    });

    it('records mediaProgress.percent on the matching message', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-video' }));
      });

      act(() => {
        result.current.setOptimisticMessageMediaProgress('msg-video', 25);
      });
      act(() => {
        result.current.setOptimisticMessageMediaProgress('msg-video', 50);
      });

      const msg = result.current.optimisticMessages[0]!;
      expect(msg.mediaProgress).toEqual({ percent: 50 });
    });

    it('does not affect other messages', () => {
      const { result } = renderHook(() => useOptimisticMessages());
      act(() => {
        result.current.addOptimisticMessage(createMessage({ id: 'msg-text' }));
        result.current.addOptimisticMessage(createMessage({ id: 'msg-image' }));
      });

      act(() => {
        result.current.setOptimisticMessageMediaStart('msg-image', 'image', 'image/png');
        result.current.setOptimisticMessageMediaProgress('msg-image', 30);
      });

      expect(result.current.optimisticMessages[0]!.mediaInFlight).toBeUndefined();
      expect(result.current.optimisticMessages[0]!.mediaProgress).toBeUndefined();
      expect(result.current.optimisticMessages[1]!.mediaInFlight?.mediaType).toBe('image');
      expect(result.current.optimisticMessages[1]!.mediaProgress?.percent).toBe(30);
    });
  });
});
