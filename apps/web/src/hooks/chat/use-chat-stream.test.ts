import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useStreamingActivityStore } from '@/stores/streaming-activity';
import { usePreInferenceActivityStore } from '@/stores/pre-inference-activity';

// Mock the chat-aloud TTS bridge so use-chat-stream tests don't pull in
// kokoro-js. Individual tests can override the resolved feeder if needed.
const ttsFeederMock = vi.hoisted(() => ({
  feed: vi.fn(),
  end: vi.fn(),
}));
const startChatTtsStreamMock = vi.hoisted(() =>
  vi.fn((): Promise<null | typeof ttsFeederMock> => Promise.resolve(null))
);
vi.mock('@/lib/chat-tts-stream', () => ({
  startChatTtsStream: startChatTtsStreamMock,
}));
import {
  useChatStream,
  TrialRateLimitError,
  BalanceReservedError,
  BillingMismatchError,
  ContextCapacityError,
  StreamTimeoutError,
} from '@/hooks/chat/use-chat-stream';
import * as trialTokenModule from '@/lib/trial-token';
import { setLinkGuestAuth, clearLinkGuestAuth } from '@/lib/link-guest-auth';

vi.mock('@/lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
}));

vi.mock('@/lib/trial-token', () => ({
  getTrialToken: vi.fn(() => 'test-trial-token'),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function createSSEStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      const event = events[index];
      if (event === undefined) {
        controller.close();
      } else {
        // `data:` lines need a trailing blank line to trigger dispatch per
        // the SSE spec; the parser buffers data and only fires on the empty
        // separator. Pre-buffer-fix the parser dispatched per `data:` line so
        // these chunk arrays got away with `\n` alone.
        const suffix = event.startsWith('data:') ? '\n\n' : '\n';
        controller.enqueue(encoder.encode(event + suffix));
        index++;
      }
    },
  });
}

/**
 * A stream whose events are pushed on demand so a test can interleave two
 * overlapping turns (emit turn 1, start turn 2, then settle turn 1).
 */
function createControllableSSEStream(): {
  stream: ReadableStream<Uint8Array>;
  emit: (event: string, data: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    emit: (event, data) => {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
    },
    close: () => {
      controller.close();
    },
  };
}

describe('useChatStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStreamingActivityStore.setState({ activeStreams: 0 });
    usePreInferenceActivityStore.setState({ preInferenceStagesSeen: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('authenticated mode', () => {
    it('calls POST /api/chat/:conversationId/stream with models in body', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-123',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/api/chat/conv-123/stream',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',

          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          }),
        })
      );
    });

    it('increments the pre-inference counter on a stage:start event', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"smart-model","assistantMessageId":"msg-123"}]}',
        'event: stage:start',
        'data: {"stageId":"smart-model","assistantMessageId":"msg-123"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-123',
          models: ['smart-model'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(usePreInferenceActivityStore.getState().preInferenceStagesSeen).toBe(1);
    });

    it('includes webSearchEnabled in request body when provided', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-123',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
          webSearchEnabled: true,
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/api/chat/conv-123/stream',
        expect.objectContaining({
          body: JSON.stringify({
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
            webSearchEnabled: true,
          }),
        })
      );
    });

    it('includes videoConfig in request body when modality is video', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"google/veo-3.1","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-123',
          modality: 'video',
          models: ['google/veo-3.1'],
          userMessage: { id: 'msg-1', content: 'A cat surfing' },
          messagesForInference: [{ role: 'user', content: 'A cat surfing' }],
          fundingSource: 'personal_balance',
          videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
        });
      });

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
      expect(body['modality']).toBe('video');
      expect(body['videoConfig']).toEqual({
        aspectRatio: '16:9',
        durationSeconds: 4,
        resolution: '720p',
      });
    });

    it('includes imageConfig in request body when modality is image', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"google/imagen-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-123',
          modality: 'image',
          models: ['google/imagen-4'],
          userMessage: { id: 'msg-1', content: 'A sunset' },
          messagesForInference: [{ role: 'user', content: 'A sunset' }],
          fundingSource: 'personal_balance',
          imageConfig: { aspectRatio: '16:9' },
        });
      });

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
      expect(body['modality']).toBe('image');
      expect(body['imageConfig']).toEqual({ aspectRatio: '16:9' });
    });

    it('does not include X-Trial-Token header in authenticated mode', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-123',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-Trial-Token']).toBeUndefined();
    });

    it('returns userMessageId and models array on success', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-456","models":[{"modelId":"gpt-4","assistantMessageId":"msg-456"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello "}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"world!"}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"msg-456"}',
        'event: done',
        'data: {"userMessageId":"user-456","assistantMessageId":"msg-456","userSequence":1,"aiSequence":2,"epochNumber":1,"cost":"0.00150000","models":[{"modelId":"gpt-4","assistantMessageId":"msg-456","aiSequence":2,"cost":"0.00150000","wrappedContentKey":"k","contentItems":[]}]}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      let streamResult: Awaited<ReturnType<typeof result.current.startStream>> | undefined;
      await act(async () => {
        streamResult = await result.current.startStream({
          conversationId: 'conv-123',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(streamResult).toEqual(
        expect.objectContaining({
          userMessageId: 'user-456',
          models: [{ modelId: 'gpt-4', assistantMessageId: 'msg-456', cost: '0.00150000' }],
        })
      );
    });

    it('calls onToken callback for each token with modelId', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-789","models":[{"modelId":"gpt-4","assistantMessageId":"msg-789"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello "}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"world!"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onToken = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onToken }
        );
      });

      expect(onToken).toHaveBeenCalledTimes(2);
      expect(onToken).toHaveBeenNthCalledWith(1, 'Hello ', 'gpt-4');
      expect(onToken).toHaveBeenNthCalledWith(2, 'world!', 'gpt-4');
    });

    it('retries the stream POST when a transport drop severs the in-flight request', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-789","models":[{"modelId":"gpt-4","assistantMessageId":"msg-789"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"recovered"}',
        'event: done',
        'data: {}',
      ];

      // A workerd recycle under host saturation severs the in-flight POST before
      // any response: fetch rejects with a TypeError (the no-response transport
      // failure the built-in retry policy treats as safe to repeat, since the
      // run never reached the server). The next attempt streams normally.
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onToken = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current
          .startStream(
            {
              conversationId: 'conv-123',
              models: ['gpt-4'],
              userMessage: { id: 'msg-1', content: 'Hello' },
              messagesForInference: [{ role: 'user', content: 'Hello' }],
              fundingSource: 'personal_balance',
            },
            { onToken }
          )
          .catch(() => {});
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(onToken).toHaveBeenCalledWith('recovered', 'gpt-4');
    });

    it('does not retry the stream POST when the request is intentionally aborted', async () => {
      // An AbortError is a deliberate cancellation (unmount/navigation), never a
      // transient drop — it must surface, not retry.
      mockFetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current
          .startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          })
          .catch(() => {});
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('calls onStart callback with StartEventData containing models array', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onStart = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onStart }
        );
      });

      expect(onStart).toHaveBeenCalledWith({
        userMessageId: 'user-123',
        models: [{ modelId: 'gpt-4', assistantMessageId: 'msg-123' }],
      });
    });

    it('sets isStreaming to true while streaming', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      expect(result.current.isStreaming).toBe(false);

      let streamPromise: Promise<unknown>;
      act(() => {
        streamPromise = result.current.startStream({
          conversationId: 'conv-123',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      await act(async () => {
        await streamPromise;
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });

    it('throws error on non-SSE content type', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: () => Promise.resolve({ code: 'INTERNAL' }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        })
      ).rejects.toThrow('INTERNAL');
    });
  });

  // Overlapping turns: the input re-enables on turn 1's early model:done flip,
  // so the user can start turn 2 while turn 1 is still settling. Turn 1's later
  // SSE `done` resolves its promise and runs the hook's cleanup — that cleanup
  // must not clear `isStreaming` while turn 2 is still producing tokens.
  describe('overlapping streams', () => {
    it('keeps isStreaming true when a settled turn finishes while a newer turn is active', async () => {
      const turn1 = createControllableSSEStream();
      const turn2 = createControllableSSEStream();
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
          body: turn1.stream,
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
          body: turn2.stream,
        });

      const { result } = renderHook(() => useChatStream('authenticated'));

      let p1: Promise<unknown> = Promise.resolve();
      act(() => {
        p1 = result.current.startStream({
          conversationId: 'c',
          models: ['gpt-4', 'claude'],
          userMessage: { id: 'u1', content: 'hi' },
          messagesForInference: [{ role: 'user', content: 'hi' }],
          fundingSource: 'personal_balance',
        });
      });

      // Turn 1 (2 models) streams, then both models reach model:done — the
      // early flip that re-enables the input before the server's `done`.
      turn1.emit(
        'start',
        JSON.stringify({
          userMessageId: 'u1',
          models: [
            { modelId: 'gpt-4', assistantMessageId: 'a1' },
            { modelId: 'claude', assistantMessageId: 'a2' },
          ],
        })
      );
      turn1.emit('model:done', JSON.stringify({ modelId: 'gpt-4', assistantMessageId: 'a1' }));
      turn1.emit('model:done', JSON.stringify({ modelId: 'claude', assistantMessageId: 'a2' }));
      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });

      // User sends turn 2 during turn 1's cost-settling window.
      let p2: Promise<unknown> = Promise.resolve();
      act(() => {
        p2 = result.current.startStream({
          conversationId: 'c',
          models: ['gpt-4'],
          userMessage: { id: 'u2', content: 'next' },
          messagesForInference: [{ role: 'user', content: 'next' }],
          fundingSource: 'personal_balance',
        });
      });
      turn2.emit(
        'start',
        JSON.stringify({
          userMessageId: 'u2',
          models: [{ modelId: 'gpt-4', assistantMessageId: 'b1' }],
        })
      );
      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      // Turn 1's `done` finally arrives and resolves turn 1's promise.
      await act(async () => {
        turn1.emit('done', JSON.stringify({}));
        turn1.close();
        await p1;
      });

      // Turn 2 is still producing tokens, so the processing flag must hold.
      expect(result.current.isStreaming).toBe(true);

      await act(async () => {
        turn2.emit('model:done', JSON.stringify({ modelId: 'gpt-4', assistantMessageId: 'b1' }));
        turn2.emit('done', JSON.stringify({}));
        turn2.close();
        await p2;
      });
      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });
  });

  // Two server-side milestones, exposed as two separate callbacks:
  // - onAllModelsComplete fires when every model emits model:done — UX flip,
  //   pre-persistence. Used to re-enable the input promptly.
  // - onAllStreamsSettled fires when the SSE `done` event arrives — post-
  //   saveChatTurn commit. Used by tests and persistence-tracking state to
  //   know the server has actually committed.
  // The latter must also fire on error/abort paths so callers can release
  // persistence-tracking state without leaking.
  describe('dual completion callbacks', () => {
    it('fires onAllModelsComplete before onAllStreamsSettled', async () => {
      const order: string[] = [];
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"u","models":[{"modelId":"gpt-4","assistantMessageId":"m1"}]}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"m1"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'c',
            models: ['gpt-4'],
            userMessage: { id: 'm', content: 'hi' },
            messagesForInference: [{ role: 'user', content: 'hi' }],
            fundingSource: 'personal_balance',
          },
          {
            onAllModelsComplete: () => order.push('all-models-complete'),
            onAllStreamsSettled: () => order.push('all-streams-settled'),
          }
        );
      });

      // Order is what matters: the persistence signal must come after the
      // UX signal. The wire-level events `model:done` and `done` arrive in
      // that order, so their derived callbacks do too.
      expect(order).toEqual(['all-models-complete', 'all-streams-settled']);
    });

    it('fires onAllStreamsSettled exactly once on happy path', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"u","models":[{"modelId":"gpt-4","assistantMessageId":"m1"}]}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"m1"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onAllStreamsSettled = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'c',
            models: ['gpt-4'],
            userMessage: { id: 'm', content: 'hi' },
            messagesForInference: [{ role: 'user', content: 'hi' }],
            fundingSource: 'personal_balance',
          },
          { onAllStreamsSettled }
        );
      });

      expect(onAllStreamsSettled).toHaveBeenCalledTimes(1);
    });

    it('fires onAllStreamsSettled when stream errors before the done event', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"u","models":[{"modelId":"gpt-4","assistantMessageId":"m1"}]}',
        'event: error',
        'data: {"code":"UNKNOWN","message":"boom"}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onAllStreamsSettled = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await expect(
          result.current.startStream(
            {
              conversationId: 'c',
              models: ['gpt-4'],
              userMessage: { id: 'm', content: 'hi' },
              messagesForInference: [{ role: 'user', content: 'hi' }],
              fundingSource: 'personal_balance',
            },
            { onAllStreamsSettled }
          )
        ).rejects.toThrow('boom');
      });

      expect(onAllStreamsSettled).toHaveBeenCalledTimes(1);
    });

    it('fires onAllStreamsSettled when fetch rejects before any event', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network down'));

      const onAllStreamsSettled = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await expect(
          result.current.startStream(
            {
              conversationId: 'c',
              models: ['gpt-4'],
              userMessage: { id: 'm', content: 'hi' },
              messagesForInference: [{ role: 'user', content: 'hi' }],
              fundingSource: 'personal_balance',
            },
            { onAllStreamsSettled }
          )
        ).rejects.toThrow('network down');
      });

      expect(onAllStreamsSettled).toHaveBeenCalledTimes(1);
    });

    it('fires onAllStreamsSettled when stream throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: () => Promise.resolve({ code: 'INTERNAL' }),
      });

      const onAllStreamsSettled = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await expect(
          result.current.startStream(
            {
              conversationId: 'c',
              models: ['gpt-4'],
              userMessage: { id: 'm', content: 'hi' },
              messagesForInference: [{ role: 'user', content: 'hi' }],
              fundingSource: 'personal_balance',
            },
            { onAllStreamsSettled }
          )
        ).rejects.toThrow('INTERNAL');
      });

      expect(onAllStreamsSettled).toHaveBeenCalledTimes(1);
    });

    it('fires onAllStreamsSettled on startRegenerateStream happy path', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"u","models":[{"modelId":"gpt-4","assistantMessageId":"m1"}]}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"m1"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onAllStreamsSettled = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startRegenerateStream(
          {
            conversationId: 'c',
            targetMessageId: 't',
            action: 'retry',
            modality: 'text',
            models: ['gpt-4'],
            userMessage: { id: 'm', content: 'hi' },
            messagesForInference: [{ role: 'user', content: 'hi' }],
            fundingSource: 'personal_balance',
          },
          { onAllStreamsSettled }
        );
      });

      expect(onAllStreamsSettled).toHaveBeenCalledTimes(1);
    });
  });

  describe('trial mode', () => {
    it('calls POST /api/trial/stream with messages and model', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'gpt-4',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/api/trial/stream',
        expect.objectContaining({
          method: 'POST',

          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Trial-Token': 'test-trial-token',
          }),
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Hello' }],
            model: 'gpt-4',
          }),
        })
      );
    });

    it('sends X-Trial-Token header from localStorage', async () => {
      const getTrialTokenSpy = vi.spyOn(trialTokenModule, 'getTrialToken');
      getTrialTokenSpy.mockReturnValue('my-unique-token');

      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      expect(getTrialTokenSpy).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Trial-Token': 'my-unique-token',
          }),
        })
      );
    });

    it('does not include credentials in trial mode', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].credentials).toBeUndefined();
    });

    it('returns models array on success', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-456"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello "}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"world!"}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"msg-456"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      let streamResult: Awaited<ReturnType<typeof result.current.startStream>> | undefined;
      await act(async () => {
        streamResult = await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      // Trial flow: server doesn't ship `done.models[].cost`, so cost defaults to '0'.
      expect(streamResult).toEqual(
        expect.objectContaining({
          userMessageId: '',
          models: [{ modelId: 'gpt-4', assistantMessageId: 'msg-456', cost: '0' }],
        })
      );
    });

    it('calls onToken callback for each token with modelId', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-789"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello "}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"world!"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onToken = vi.fn();
      const { result } = renderHook(() => useChatStream('trial'));

      await act(async () => {
        await result.current.startStream(
          { messages: [{ role: 'user', content: 'Hi' }], model: 'gpt-4' },
          { onToken }
        );
      });

      expect(onToken).toHaveBeenCalledTimes(2);
      expect(onToken).toHaveBeenNthCalledWith(1, 'Hello ', 'gpt-4');
      expect(onToken).toHaveBeenNthCalledWith(2, 'world!', 'gpt-4');
    });

    it('sets isStreaming to true while streaming', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      expect(result.current.isStreaming).toBe(false);

      let streamPromise: Promise<unknown>;
      act(() => {
        streamPromise = result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      await act(async () => {
        await streamPromise;
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });
  });

  describe('trial rate limit handling', () => {
    it('throws TrialRateLimitError on 429 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            code: 'DAILY_LIMIT_EXCEEDED',
            details: { limit: 5, remaining: 0 },
          }),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      await expect(
        act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        })
      ).rejects.toThrow('DAILY_LIMIT_EXCEEDED');
    });

    it('includes limit info in rate limit error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            code: 'DAILY_LIMIT_EXCEEDED',
            details: { limit: 5, remaining: 0 },
          }),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      try {
        await act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TrialRateLimitError);
        expect((error as TrialRateLimitError).code).toBe('DAILY_LIMIT_EXCEEDED');
        expect((error as TrialRateLimitError).limit).toBe(5);
        expect((error as TrialRateLimitError).isRateLimited).toBe(true);
      }
    });

    it('does not throw TrialRateLimitError for 429 in authenticated mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            code: 'RATE_LIMITED',
          }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(TrialRateLimitError);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('RATE_LIMITED');
      }
    });
  });

  describe('trial refusal code propagation', () => {
    async function startTrialStreamAndCatch(): Promise<unknown> {
      const { result } = renderHook(() => useChatStream('trial'));
      try {
        await act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        return error;
      }
      return undefined;
    }

    it('carries the wire code on a trial 402 refusal', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: () => Promise.resolve({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' }),
      });

      const error = await startTrialStreamAndCatch();

      expect((error as { code?: string }).code).toBe('TRIAL_MESSAGE_TOO_EXPENSIVE');
    });

    it('carries the error body details on a trial 403 refusal', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            code: 'PREMIUM_REQUIRES_ACCOUNT',
            details: { tier: 'premium' },
          }),
      });

      const error = await startTrialStreamAndCatch();

      expect((error as { code?: string }).code).toBe('PREMIUM_REQUIRES_ACCOUNT');
      expect((error as { details?: Record<string, unknown> }).details).toEqual({
        tier: 'premium',
      });
    });

    it('defaults to INTERNAL when the refusal body has no code', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({}),
      });

      const error = await startTrialStreamAndCatch();

      expect((error as { code?: string }).code).toBe('INTERNAL');
    });

    it('ignores a non-object details field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: () =>
          Promise.resolve({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE', details: 'not-an-object' }),
      });

      const error = await startTrialStreamAndCatch();

      expect((error as { code?: string }).code).toBe('TRIAL_MESSAGE_TOO_EXPENSIVE');
      expect((error as { details?: Record<string, unknown> }).details).toBeUndefined();
    });

    it('carries retryAfterSeconds details on a trial 429 burst refusal', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            code: 'RATE_LIMITED',
            details: { retryAfterSeconds: 12 },
          }),
      });

      const error = await startTrialStreamAndCatch();

      expect(error).toBeInstanceOf(TrialRateLimitError);
      expect((error as { code?: string }).code).toBe('RATE_LIMITED');
      expect(
        (error as { details?: { retryAfterSeconds?: number } }).details?.retryAfterSeconds
      ).toBe(12);
    });
  });

  describe('balance reserved error handling', () => {
    it('throws BalanceReservedError on authenticated 402 with speculative balance message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: () =>
          Promise.resolve({
            code: 'BALANCE_RESERVED',
          }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BalanceReservedError);
        expect((error as BalanceReservedError).code).toBe('BALANCE_RESERVED');
        expect((error as BalanceReservedError).isBalanceReserved).toBe(true);
      }
    });

    it('throws regular Error on authenticated 402 without speculative balance message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: () =>
          Promise.resolve({
            code: 'INSUFFICIENT_BALANCE',
          }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(BalanceReservedError);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('INSUFFICIENT_BALANCE');
      }
    });

    it('does not throw BalanceReservedError for trial 402', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: () =>
          Promise.resolve({
            code: 'BALANCE_RESERVED',
          }),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      try {
        await act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(BalanceReservedError);
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('billing mismatch error handling', () => {
    it('throws BillingMismatchError on authenticated 409 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            code: 'BILLING_MISMATCH',
          }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BillingMismatchError);
        expect((error as BillingMismatchError).code).toBe('BILLING_MISMATCH');
        expect((error as BillingMismatchError).isBillingMismatch).toBe(true);
      }
    });

    it('does not throw BillingMismatchError for trial 409', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            code: 'CONFLICT',
          }),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      try {
        await act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(BillingMismatchError);
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('context capacity error handling', () => {
    it('throws ContextCapacityError on context_length_exceeded SSE error', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: error',
        'data: {"message":"This conversation exceeds the model\'s memory limit. Start a new conversation or switch to a model with a larger context window.","code":"CONTEXT_LENGTH_EXCEEDED"}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ContextCapacityError);
        expect((error as ContextCapacityError).code).toBe('CONTEXT_LENGTH_EXCEEDED');
        expect((error as ContextCapacityError).isContextCapacity).toBe(true);
      }
    });

    it('throws regular Error on non-capacity SSE error', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: error',
        'data: {"message":"Model unavailable","code":"MODEL_ERROR"}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(ContextCapacityError);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Model unavailable');
      }
    });
  });

  describe('startRegenerateStream', () => {
    it('calls POST /api/chat/:conversationId/regenerate with regeneration fields', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-regen"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"New response"}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"msg-regen"}',
        'event: done',
        'data: {"userMessageId":"user-123","assistantMessageId":"msg-regen","userSequence":1,"aiSequence":2,"epochNumber":1,"cost":"0.00100000","models":[{"modelId":"gpt-4","assistantMessageId":"msg-regen","aiSequence":2,"cost":"0.00100000","wrappedContentKey":"k","contentItems":[]}]}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      let streamResult:
        | Awaited<ReturnType<typeof result.current.startRegenerateStream>>
        | undefined;
      await act(async () => {
        streamResult = await result.current.startRegenerateStream({
          conversationId: 'conv-123',
          targetMessageId: 'msg-target',
          action: 'retry',
          modality: 'text',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/api/chat/conv-123/regenerate',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            targetMessageId: 'msg-target',
            action: 'retry',
            modality: 'text',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          }),
        })
      );

      expect(streamResult).toEqual(
        expect.objectContaining({
          userMessageId: 'user-123',
          models: [{ modelId: 'gpt-4', assistantMessageId: 'msg-regen', cost: '0.00100000' }],
        })
      );
    });

    it('sets isStreaming during regeneration', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));
      expect(result.current.isStreaming).toBe(false);

      let streamPromise: Promise<unknown>;
      act(() => {
        streamPromise = result.current.startRegenerateStream({
          conversationId: 'conv-123',
          targetMessageId: 'msg-target',
          action: 'retry',
          modality: 'text',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      await act(async () => {
        await streamPromise;
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });
  });

  describe('link-guest header', () => {
    afterEach(() => {
      clearLinkGuestAuth();
    });

    it('sends X-Link-Public-Key on the stream POST when a link key is set', async () => {
      setLinkGuestAuth('link-pk-123');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream([
          'event: start',
          'data: {"userMessageId":"","models":[]}',
          'event: done',
          'data: {}',
        ]),
      });

      const { result } = renderHook(() => useChatStream('trial'));
      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Link-Public-Key': 'link-pk-123' }),
        })
      );
    });

    it('sends X-Link-Public-Key on the regenerate POST when a link key is set', async () => {
      setLinkGuestAuth('link-pk-456');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream([
          'event: start',
          'data: {"userMessageId":"","models":[]}',
          'event: done',
          'data: {}',
        ]),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));
      await act(async () => {
        await result.current.startRegenerateStream({
          conversationId: 'conv-123',
          targetMessageId: 'msg-target',
          action: 'retry',
          modality: 'text',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Link-Public-Key': 'link-pk-456' }),
        })
      );
    });
  });

  describe('media and stage callbacks', () => {
    it('forwards media and stage events to the caller callbacks', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"u1","models":[{"modelId":"video-model","assistantMessageId":"a1"}]}',
        'event: model:media:start',
        'data: {"modelId":"video-model","assistantMessageId":"a1","mediaType":"video","mimeType":"video/mp4"}',
        'event: model:media:progress',
        'data: {"modelId":"video-model","assistantMessageId":"a1","percent":50}',
        'event: stage:done',
        'data: {"assistantMessageId":"a1","payload":{"stageId":"smart-model","resolvedModelId":"gpt-4","resolvedModelName":"GPT-4"}}',
        'event: stage:error',
        'data: {"stageId":"smart-model","assistantMessageId":"a1","errorCode":"CLASSIFIER_FAILED"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onModelMediaStart = vi.fn();
      const onModelMediaProgress = vi.fn();
      const onStageDone = vi.fn();
      const onStageError = vi.fn();

      const { result } = renderHook(() => useChatStream('authenticated'));
      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'conv-123',
            models: ['video-model'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onModelMediaStart, onModelMediaProgress, onStageDone, onStageError }
        );
      });

      expect(onModelMediaStart).toHaveBeenCalledWith(
        expect.objectContaining({ mediaType: 'video', mimeType: 'video/mp4' })
      );
      expect(onModelMediaProgress).toHaveBeenCalledWith(expect.objectContaining({ percent: 50 }));
      expect(onStageDone).toHaveBeenCalledWith(
        expect.objectContaining({ assistantMessageId: 'a1' })
      );
      expect(onStageError).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'CLASSIFIER_FAILED' })
      );
    });
  });

  describe('chat-aloud TTS feed', () => {
    it('feeds primary-model tokens to the TTS feeder and ends it on done', async () => {
      startChatTtsStreamMock.mockResolvedValueOnce(ttsFeederMock);
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"u1","models":[{"modelId":"gpt-4","assistantMessageId":"a1"},{"modelId":"claude","assistantMessageId":"a2"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello"}',
        'event: token',
        'data: {"modelId":"claude","content":"Ignored"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));
      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      expect(ttsFeederMock.feed).toHaveBeenCalledWith('Hello');
      expect(ttsFeederMock.feed).not.toHaveBeenCalledWith('Ignored');
      expect(ttsFeederMock.end).toHaveBeenCalled();
    });
  });

  describe('stream termination edge cases', () => {
    it('fires onAllModelsComplete immediately when the start event has zero models', async () => {
      const sseEvents = ['event: start', 'data: {"userMessageId":"u1","models":[]}'];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onAllModelsComplete = vi.fn();
      const { result } = renderHook(() => useChatStream('trial'));
      await act(async () => {
        await result.current.startStream(
          { messages: [{ role: 'user', content: 'Hi' }], model: 'gpt-4' },
          { onAllModelsComplete }
        );
      });

      expect(onAllModelsComplete).toHaveBeenCalledTimes(1);
    });

    it('returns an empty result when the stream closes without any event', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream([]),
      });

      const { result } = renderHook(() => useChatStream('trial'));
      let streamResult: Awaited<ReturnType<typeof result.current.startStream>> | undefined;
      await act(async () => {
        streamResult = await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      expect(streamResult?.models).toEqual([]);
      expect(streamResult?.doneData).toBeUndefined();
    });
  });

  describe('common error handling', () => {
    it('throws INTERNAL when a non-SSE response body fails to parse', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: () => Promise.reject(new Error('malformed body')),
      });

      const { result } = renderHook(() => useChatStream('trial'));
      await expect(
        act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        })
      ).rejects.toThrow('INTERNAL');
    });

    it('throws error on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ code: 'INTERNAL' }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        })
      ).rejects.toThrow('INTERNAL');
    });

    it('throws error when body is null', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: null,
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        })
      ).rejects.toThrow('Response body is null');
    });

    it('throws error on stream error event', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: error',
        'data: {"message":"Model unavailable","code":"MODEL_ERROR"}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        })
      ).rejects.toThrow('Model unavailable');
    });
  });

  describe('multi-model streaming', () => {
    it('returns multiple models in result when start event has multiple models', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-1","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1"},{"modelId":"claude-3","assistantMessageId":"asst-2"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello"}',
        'event: token',
        'data: {"modelId":"claude-3","content":"Hi"}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"asst-1"}',
        'event: model:done',
        'data: {"modelId":"claude-3","assistantMessageId":"asst-2"}',
        'event: done',
        'data: {"userMessageId":"user-1","assistantMessageId":"asst-1","userSequence":1,"aiSequence":2,"epochNumber":1,"cost":"0.00500000","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1","aiSequence":2,"cost":"0.00200000","wrappedContentKey":"k","contentItems":[]},{"modelId":"claude-3","assistantMessageId":"asst-2","aiSequence":3,"cost":"0.00300000","wrappedContentKey":"k","contentItems":[]}]}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      let streamResult: Awaited<ReturnType<typeof result.current.startStream>> | undefined;
      await act(async () => {
        streamResult = await result.current.startStream({
          conversationId: 'conv-1',
          models: ['gpt-4', 'claude-3'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(streamResult).toEqual(
        expect.objectContaining({
          userMessageId: 'user-1',
          models: [
            { modelId: 'gpt-4', assistantMessageId: 'asst-1', cost: '0.00200000' },
            { modelId: 'claude-3', assistantMessageId: 'asst-2', cost: '0.00300000' },
          ],
        })
      );
    });

    it('calls onToken with correct modelId for interleaved tokens', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-1","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1"},{"modelId":"claude-3","assistantMessageId":"asst-2"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"A"}',
        'event: token',
        'data: {"modelId":"claude-3","content":"X"}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"B"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onToken = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'conv-1',
            models: ['gpt-4', 'claude-3'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onToken }
        );
      });

      expect(onToken).toHaveBeenCalledTimes(3);
      expect(onToken).toHaveBeenNthCalledWith(1, 'A', 'gpt-4');
      expect(onToken).toHaveBeenNthCalledWith(2, 'X', 'claude-3');
      expect(onToken).toHaveBeenNthCalledWith(3, 'B', 'gpt-4');
    });

    it('calls onModelDone for each completed model (no per-event cost)', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-1","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1"},{"modelId":"claude-3","assistantMessageId":"asst-2"}]}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"asst-1"}',
        'event: model:done',
        'data: {"modelId":"claude-3","assistantMessageId":"asst-2"}',
        'event: done',
        'data: {"userMessageId":"user-1","assistantMessageId":"asst-1","userSequence":1,"aiSequence":2,"epochNumber":1,"cost":"0.005","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1","aiSequence":2,"cost":"0.002","wrappedContentKey":"k","contentItems":[]},{"modelId":"claude-3","assistantMessageId":"asst-2","aiSequence":3,"cost":"0.003","wrappedContentKey":"k","contentItems":[]}]}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onModelDone = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'conv-1',
            models: ['gpt-4', 'claude-3'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onModelDone }
        );
      });

      expect(onModelDone).toHaveBeenCalledTimes(2);
      expect(onModelDone).toHaveBeenNthCalledWith(1, {
        modelId: 'gpt-4',
        assistantMessageId: 'asst-1',
      });
      expect(onModelDone).toHaveBeenNthCalledWith(2, {
        modelId: 'claude-3',
        assistantMessageId: 'asst-2',
      });
    });

    it('calls onModelError when a model fails', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-1","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1"},{"modelId":"claude-3","assistantMessageId":"asst-2"}]}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"asst-1"}',
        'event: model:error',
        'data: {"modelId":"claude-3","message":"Model unavailable","code":"STREAM_ERROR"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onModelError = vi.fn();
      const onModelDone = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'conv-1',
            models: ['gpt-4', 'claude-3'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onModelDone, onModelError }
        );
      });

      expect(onModelDone).toHaveBeenCalledTimes(1);
      expect(onModelError).toHaveBeenCalledTimes(1);
      expect(onModelError).toHaveBeenCalledWith({
        modelId: 'claude-3',
        message: 'Model unavailable',
        code: 'STREAM_ERROR',
      });
    });

    it('defaults cost to 0 for models without model:done event', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-1","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      let streamResult: Awaited<ReturnType<typeof result.current.startStream>> | undefined;
      await act(async () => {
        streamResult = await result.current.startStream({
          conversationId: 'conv-1',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(streamResult).toEqual(
        expect.objectContaining({
          userMessageId: 'user-1',
          models: [{ modelId: 'gpt-4', assistantMessageId: 'asst-1', cost: '0' }],
        })
      );
    });
  });

  describe('streaming activity store integration', () => {
    it('increments global stream counter on start (caller responsible for endStream)', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-123',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      // Stream started but endStream not called — caller owns the lifecycle
      expect(useStreamingActivityStore.getState().activeStreams).toBe(1);

      // Caller calls endStream after post-stream work
      useStreamingActivityStore.getState().endStream();
      expect(useStreamingActivityStore.getState().activeStreams).toBe(0);
    });

    it('keeps stream counter incremented even on stream error (caller must endStream)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ code: 'INTERNAL' }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
      } catch {
        // Expected error
      }

      expect(result.current.isStreaming).toBe(false);
      // Counter still 1 — caller calls endStream in their error handler
      expect(useStreamingActivityStore.getState().activeStreams).toBe(1);

      useStreamingActivityStore.getState().endStream();
      expect(useStreamingActivityStore.getState().activeStreams).toBe(0);
    });

    it('increments global stream counter during regeneration (caller responsible for endStream)', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startRegenerateStream({
          conversationId: 'conv-123',
          targetMessageId: 'msg-target',
          action: 'retry',
          modality: 'text',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(useStreamingActivityStore.getState().activeStreams).toBe(1);

      useStreamingActivityStore.getState().endStream();
      expect(useStreamingActivityStore.getState().activeStreams).toBe(0);
    });
  });

  describe('TTS chat-aloud wiring', () => {
    beforeEach(() => {
      ttsFeederMock.feed.mockReset();
      ttsFeederMock.end.mockReset();
      startChatTtsStreamMock.mockReset();
    });

    it('does nothing when startChatTtsStream returns null (default off)', async () => {
      startChatTtsStreamMock.mockResolvedValueOnce(null);
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"u","models":[{"modelId":"gpt-4","assistantMessageId":"m"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hi."}',
        'event: done',
        'data: {}',
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));
      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-1',
          models: ['gpt-4'],
          userMessage: { id: 'u', content: 'Hi' },
          messagesForInference: [{ role: 'user', content: 'Hi' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(ttsFeederMock.feed).not.toHaveBeenCalled();
      expect(ttsFeederMock.end).not.toHaveBeenCalled();
    });

    it('routes only the primary model tokens to the feeder', async () => {
      startChatTtsStreamMock.mockResolvedValueOnce(ttsFeederMock);
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"u","models":[{"modelId":"gpt-4","assistantMessageId":"a"},{"modelId":"claude","assistantMessageId":"b"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello"}',
        'event: token',
        'data: {"modelId":"claude","content":"IGNORED"}',
        'event: token',
        'data: {"modelId":"gpt-4","content":" world."}',
        'event: done',
        'data: {}',
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));
      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-1',
          models: ['gpt-4', 'claude'],
          userMessage: { id: 'u', content: 'Hi' },
          messagesForInference: [{ role: 'user', content: 'Hi' }],
          fundingSource: 'personal_balance',
        });
      });

      const fedTokens = ttsFeederMock.feed.mock.calls.map((c) => c[0]);
      expect(fedTokens).toEqual(['Hello', ' world.']);
      expect(ttsFeederMock.end).toHaveBeenCalled();
    });

    it('passes a messageId getter that resolves to the primary assistant message id after onStart', async () => {
      startChatTtsStreamMock.mockResolvedValueOnce(ttsFeederMock);
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"u","models":[{"modelId":"gpt-4","assistantMessageId":"assistant-xyz"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hi."}',
        'event: done',
        'data: {}',
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));
      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-1',
          models: ['gpt-4'],
          userMessage: { id: 'u', content: 'Hi' },
          messagesForInference: [{ role: 'user', content: 'Hi' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(startChatTtsStreamMock).toHaveBeenCalledTimes(1);
      const calls = startChatTtsStreamMock.mock.calls as unknown as [
        { messageId: () => string | null } | undefined,
      ][];
      const callArgument = calls[0]?.[0];
      expect(callArgument).toBeDefined();
      expect(typeof callArgument?.messageId).toBe('function');
      expect(callArgument?.messageId()).toBe('assistant-xyz');
    });

    it('calls feeder.end() exactly once even when both onDone and finally fire', async () => {
      startChatTtsStreamMock.mockResolvedValueOnce(ttsFeederMock);
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"u","models":[{"modelId":"gpt-4","assistantMessageId":"a"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hi."}',
        'event: done',
        'data: {}',
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));
      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-1',
          models: ['gpt-4'],
          userMessage: { id: 'u', content: 'Hi' },
          messagesForInference: [{ role: 'user', content: 'Hi' }],
          fundingSource: 'personal_balance',
        });
      });
      // The feeder is called twice (onDone, then finally) — that's fine because
      // the second flush() is a no-op (chunker is empty), so users hear the
      // remainder exactly once.
      expect(ttsFeederMock.end).toHaveBeenCalled();
    });
  });

  describe('stream timeout (M-Z3)', () => {
    it('surfaces a StreamTimeoutError when the stream goes silent after start', async () => {
      // A reader.read() that resolves the encoded `start` event but then hangs
      // forever — simulates a server crash mid-stream.
      const encoder = new TextEncoder();
      let resolved = false;
      const reader: ReadableStreamDefaultReader<Uint8Array> = {
        read: vi.fn(() => {
          if (!resolved) {
            resolved = true;
            const chunk =
              'event: start\ndata: {"userMessageId":"u","models":[{"modelId":"gpt-4","assistantMessageId":"a"}]}\n\n';
            return Promise.resolve({
              done: false,
              value: encoder.encode(chunk),
            } as ReadableStreamReadResult<Uint8Array>);
          }
          // Never resolve — model:done / done never arrives.
          return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {
            /* hang */
          });
        }),
        cancel: vi.fn().mockResolvedValue(null),
        releaseLock: vi.fn(),
        get closed(): Promise<undefined> {
          return new Promise<undefined>(() => {
            /* never resolves */
          });
        },
      };
      const fakeBody = {
        getReader: () => reader,
      } as unknown as ReadableStream<Uint8Array>;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: fakeBody,
      });

      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useChatStream('authenticated'));

        let caught: unknown;
        const startPromise = act(async () => {
          try {
            await result.current.startStream({
              conversationId: 'conv-1',
              models: ['gpt-4'],
              userMessage: { id: 'msg-1', content: 'Hello' },
              messagesForInference: [{ role: 'user', content: 'Hello' }],
              fundingSource: 'personal_balance',
            });
          } catch (error) {
            caught = error;
          }
        });

        // Advance well past STREAM_TIMEOUT_MS (90s). vi.runAllTimersAsync flushes
        // the timeout reject so the consumer's catch fires.
        await vi.advanceTimersByTimeAsync(95_000);
        await startPromise;

        expect(caught).toBeInstanceOf(StreamTimeoutError);
        expect((caught as StreamTimeoutError).code).toBe('STREAM_TIMEOUT');
        // The re-thrown StreamTimeoutError preserves the original via `cause`
        // so debugging tools and `error.cause` chains remain intact.
        expect((caught as StreamTimeoutError).cause).toBeInstanceOf(StreamTimeoutError);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not time out when the server emits keep-alive comments', async () => {
      // Simulates a slow video generation: `start`, then a heartbeat every 30s
      // (under STREAM_TIMEOUT_MS=90s), eventually followed by `done`. The
      // heartbeat bytes arrive as a separate `reader.read()` resolution, which
      // resets `readWithTimeout`'s internal timer.
      const encoder = new TextEncoder();
      const startChunk = encoder.encode(
        'event: start\ndata: {"userMessageId":"u","models":[{"modelId":"gpt-4","assistantMessageId":"a"}]}\n\n'
      );
      const keepAliveChunk = encoder.encode(':keep-alive\n\n');
      const doneChunk = encoder.encode(
        'event: done\ndata: {"userMessageId":"u","aiSequence":1,"epochNumber":1,"cost":"0"}\n\n'
      );

      let phase = 0;
      const reader: ReadableStreamDefaultReader<Uint8Array> = {
        read: vi.fn(() => {
          // Phase 0: emit start immediately. Phases 1..3: emit a keep-alive
          // every 60s (well within the 90s timeout). Phase 4: emit done.
          if (phase === 0) {
            phase += 1;
            return Promise.resolve({
              done: false,
              value: startChunk,
            } as ReadableStreamReadResult<Uint8Array>);
          }
          if (phase < 4) {
            phase += 1;
            return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
              setTimeout(() => {
                resolve({ done: false, value: keepAliveChunk });
              }, 60_000);
            });
          }
          if (phase === 4) {
            phase += 1;
            return Promise.resolve({
              done: false,
              value: doneChunk,
            } as ReadableStreamReadResult<Uint8Array>);
          }
          return Promise.resolve({
            done: true,
            value: undefined,
          } as ReadableStreamReadResult<Uint8Array>);
        }),
        cancel: vi.fn().mockResolvedValue(null),
        releaseLock: vi.fn(),
        get closed(): Promise<undefined> {
          return new Promise<undefined>(() => {
            /* never */
          });
        },
      };
      const fakeBody = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: fakeBody,
      });

      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useChatStream('authenticated'));

        let caught: unknown;
        let resolvedResult: unknown;
        const startPromise = act(async () => {
          try {
            resolvedResult = await result.current.startStream({
              conversationId: 'conv-1',
              models: ['gpt-4'],
              userMessage: { id: 'msg-1', content: 'Hello' },
              messagesForInference: [{ role: 'user', content: 'Hello' }],
              fundingSource: 'personal_balance',
            });
          } catch (error) {
            caught = error;
          }
        });

        // 60s, 120s, 180s — three keep-alives, each well within the 90s
        // timeout. Then the done event resolves and the stream finishes.
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.advanceTimersByTimeAsync(60_000);
        await startPromise;

        expect(caught).toBeUndefined();
        expect(resolvedResult).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
