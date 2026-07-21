import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SMART_MODEL_ID } from '@hushbox/shared';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useChatStream,
  ChatRequestError,
  ChatRunFailedError,
  type AuthenticatedStreamRequest,
  type RegenerateStreamRequest,
  type StreamResult,
} from '@/hooks/chat/use-chat-stream';
import { resetRunOwnershipForTests, isLocalRun } from '@/lib/run-ownership';
import type { RunFrame } from '@/lib/server-frames';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeSocket {
  connect: () => void;
  waitForReady: (timeoutMs: number) => Promise<boolean>;
  readonly ready: boolean;
  onRunFrame: (listener: (frame: RunFrame) => void) => () => void;
  onStateChange: (listener: () => void) => () => void;
  emit: (frame: RunFrame) => void;
}

function createFakeSocket(): FakeSocket {
  const frameListeners = new Set<(frame: RunFrame) => void>();
  const stateListeners = new Set<() => void>();
  return {
    connect: vi.fn(),
    waitForReady: () => Promise.resolve(true),
    ready: true,
    onRunFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    emit(frame) {
      for (const listener of frameListeners) listener(frame);
    },
  };
}

const sockets = vi.hoisted(() => ({
  conversation: null as unknown,
  trial: null as unknown,
  acquireConversation: vi.fn(),
  releaseConversation: vi.fn(),
  acquireTrial: vi.fn(),
  releaseTrial: vi.fn(),
}));

vi.mock('@/lib/conversation-socket-registry', () => ({
  acquireConversationSocket: (id: string): unknown => {
    sockets.acquireConversation(id);
    return sockets.conversation;
  },
  releaseConversationSocket: (id: string): void => {
    sockets.releaseConversation(id);
  },
  acquireTrialSocket: (token: string): unknown => {
    sockets.acquireTrial(token);
    return sockets.trial;
  },
  releaseTrialSocket: (token: string): void => {
    sockets.releaseTrial(token);
  },
}));

const postSpies = vi.hoisted(() => ({
  chat: vi.fn(),
  guest: vi.fn(),
  regenerate: vi.fn(),
  trial: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  client: {
    chat: {
      $post: (...args: unknown[]): unknown => postSpies.chat(...args),
      guest: { $post: (...args: unknown[]): unknown => postSpies.guest(...args) },
      regenerate: { $post: (...args: unknown[]): unknown => postSpies.regenerate(...args) },
      trial: { $post: (...args: unknown[]): unknown => postSpies.trial(...args) },
      stop: { $post: (...args: unknown[]): unknown => postSpies.stop(...args) },
    },
  },
}));

const mockGetLinkGuestAuth = vi.hoisted(() => vi.fn<() => string | null>(() => null));
vi.mock('@/lib/link-guest-auth', () => ({
  getLinkGuestAuth: (): string | null => mockGetLinkGuestAuth(),
}));

interface FakeTtsFeeder {
  feed: (token: string) => void;
  end: () => void;
}

const ttsMock = vi.hoisted(() => ({
  feeder: null as { feed: (token: string) => void; end: () => void } | null,
  probedMessageIds: [] as (string | null)[],
}));
vi.mock('@/lib/chat-tts-stream', () => ({
  // Probe the messageId closure like the real feeder does when it binds the
  // primary tile; return the configured feeder (null = TTS off, the default).
  startChatTtsStream: (options: {
    messageId: () => string | null;
  }): Promise<FakeTtsFeeder | null> => {
    ttsMock.probedMessageIds.push(options.messageId());
    return Promise.resolve(ttsMock.feeder);
  },
}));

// `@/lib/retry` transitively imports `@/lib/api`, whose env parse fails under
// jsdom; mirror the one predicate the hook uses (no-response TypeError only).
vi.mock('@/lib/retry', () => ({
  shouldRetryMutation: (_failureCount: number, error: unknown): boolean =>
    error instanceof TypeError,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const startedResponse = (runId = 'run-1'): Response =>
  jsonResponse({ runId, deadlineAt: Date.now() + 300_000 }, 201);

function baseRequest(
  overrides: Partial<AuthenticatedStreamRequest> = {}
): AuthenticatedStreamRequest {
  return {
    conversationId: 'conv-1',
    models: ['model-a'],
    userMessage: { id: 'user-msg-1', content: 'hello' },
    messagesForInference: [{ role: 'user', content: 'hello' }],
    fundingSource: 'personal_balance',
    ...overrides,
  };
}

interface StreamStartCapture {
  tiles: { modelId: string; assistantMessageId: string }[];
}

/**
 * Detaches a promise so a rejection before the test's own await cannot
 * surface as an unhandled rejection (the test still awaits/asserts it).
 */
function armed(promise: Promise<unknown>): void {
  void (async (): Promise<void> => {
    try {
      await promise;
    } catch {
      // observed by the test's own await/assertion
    }
  })();
}

/** Drives a run to success by emitting the full frame sequence for each tile. */
function finishRun(socket: FakeSocket, capture: StreamStartCapture, content = 'Hi'): void {
  for (const [index, tile] of capture.tiles.entries()) {
    const streamId = `answer${String(index)}#${String(index)}`;
    socket.emit({
      type: 'stream',
      streamId,
      cursor: 1,
      event: { kind: 'stream-start', modelId: tile.modelId },
    } as RunFrame);
    socket.emit({
      type: 'stream',
      streamId,
      cursor: 2,
      event: { kind: 'text-delta', index: 0, content },
    } as RunFrame);
    socket.emit({
      type: 'stream',
      streamId,
      cursor: 3,
      event: {
        kind: 'finish',
        metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      },
    } as RunFrame);
  }
  socket.emit({
    type: 'run-finished',
    runId: 'run-1',
    outcome: { outcome: 'succeeded' },
  } as RunFrame);
}

describe('useChatStream (run transport)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunOwnershipForTests();
    localStorage.clear();
    sockets.conversation = createFakeSocket();
    sockets.trial = createFakeSocket();
    mockGetLinkGuestAuth.mockReturnValue(null);
    ttsMock.feeder = null;
    ttsMock.probedMessageIds = [];
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('authenticated send', () => {
    it('POSTs the run body with an Idempotency-Key and streams to completion', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const tokens: [string, string][] = [];
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          baseRequest({
            messagesForInference: [
              { role: 'user', content: 'earlier question' },
              { role: 'assistant', content: 'earlier answer' },
              { role: 'system', content: 'be nice' },
              { role: 'user', content: 'hello' },
            ],
            webSearchEnabled: true,
            forkId: 'fork-1',
          }),
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
            onToken: (token, id) => tokens.push([token, id]),
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });

      const streamResult = await promise;
      expect(streamResult.outcome).toBe('succeeded');
      expect(streamResult.userMessageId).toBe('user-msg-1');
      expect(streamResult.models).toEqual([
        { modelId: 'model-a', assistantMessageId: capture.tiles[0]?.assistantMessageId },
      ]);
      expect(tokens).toEqual([['Hi', capture.tiles[0]?.assistantMessageId]]);

      const [args, init] = postSpies.chat.mock.calls[0] as [
        { json: Record<string, unknown> },
        { headers: Record<string, string> },
      ];
      expect(init.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/);
      expect(args.json).toEqual({
        conversationId: 'conv-1',
        model: 'model-a',
        modality: 'text',
        webSearchEnabled: true,
        forkId: 'fork-1',
        userMessage: { id: 'user-msg-1', content: 'hello' },
        history: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ],
      });
    });

    it('sends the models array for a multi-model turn and demuxes per tile', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ models: ['model-a', 'model-b'] }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(2);
      });
      expect(capture.tiles.map((t) => t.modelId)).toEqual(['model-a', 'model-b']);
      act(() => {
        finishRun(socket, capture);
      });

      const streamResult = await promise;
      expect(streamResult.models).toHaveLength(2);

      const [args] = postSpies.chat.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['models']).toEqual(['model-a', 'model-b']);
      expect(args.json['model']).toBe('model-a');
    });

    it('sends the Smart Model sentinel as a single-tile turn without models[]', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const resolved: [string | undefined, string][] = [];
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ models: ['smart-model'] }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onModelResolved: (id, modelId) => resolved.push([id, modelId]),
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 1,
          event: { kind: 'stream-start', modelId: 'anthropic/claude-sonnet' },
        } as RunFrame);
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 2,
          event: {
            kind: 'finish',
            metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
          },
        } as RunFrame);
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });

      const streamResult = await promise;
      expect(resolved).toEqual([[capture.tiles[0]?.assistantMessageId, 'anthropic/claude-sonnet']]);
      expect(streamResult.models[0]?.modelId).toBe('anthropic/claude-sonnet');

      const [args] = postSpies.chat.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['model']).toBe('smart-model');
      expect(args.json['models']).toBeUndefined();
    });

    it('routes a link-guest send through the guest route', async () => {
      mockGetLinkGuestAuth.mockReturnValue('link-key');
      postSpies.guest.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(postSpies.guest).toHaveBeenCalled();
      });
      expect(postSpies.chat).not.toHaveBeenCalled();
      act(() => {
        finishRun(socket, capture);
      });
      await promise;
    });

    it('throws ChatRequestError with the wire code on a refusal', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ code: 'CONCURRENT_RUN' }, 409));
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(act(() => result.current.startStream(baseRequest()))).rejects.toMatchObject({
        name: 'ChatRequestError',
        code: 'CONCURRENT_RUN',
        status: 409,
      });
    });

    it('returns a replayed outcome for a settled-run replay without firing onStart', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ some: 'persisted-response' }, 200));
      const onStart = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      let streamResult!: StreamResult;
      await act(async () => {
        streamResult = await result.current.startStream(baseRequest(), { onStart });
      });

      expect(streamResult.outcome).toBe('replayed');
      expect(onStart).not.toHaveBeenCalled();
    });

    it('throws ChatRunFailedError when the run finishes failed', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      let promise!: Promise<StreamResult>;
      const onStart = vi.fn();
      act(() => {
        promise = result.current.startStream(baseRequest(), { onStart });
        armed(promise);
      });
      await waitFor(() => {
        expect(onStart).toHaveBeenCalled();
      });
      act(() => {
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'failed', code: 'INTERNAL' },
        } as RunFrame);
      });

      await expect(promise).rejects.toBeInstanceOf(ChatRunFailedError);
    });

    it('reuses the same Idempotency-Key when the POST transport drops', async () => {
      postSpies.chat
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(postSpies.chat).toHaveBeenCalledTimes(2);
      });
      const firstInit = postSpies.chat.mock.calls[0]?.[1] as { headers: Record<string, string> };
      const secondInit = postSpies.chat.mock.calls[1]?.[1] as { headers: Record<string, string> };
      expect(firstInit.headers['Idempotency-Key']).toBe(secondInit.headers['Idempotency-Key']);

      act(() => {
        finishRun(socket, capture);
      });
      await promise;
    });

    it('marks the run as locally owned while it is in flight', async () => {
      postSpies.chat.mockResolvedValue(startedResponse('run-owned'));
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      expect(isLocalRun('conv-1', 'run-owned')).toBe(true);

      act(() => {
        for (const [index, tile] of capture.tiles.entries()) {
          const streamId = `answer${String(index)}#${String(index)}`;
          socket.emit({
            type: 'stream',
            streamId,
            cursor: 1,
            event: { kind: 'stream-start', modelId: tile.modelId },
          } as RunFrame);
          socket.emit({
            type: 'stream',
            streamId,
            cursor: 2,
            event: {
              kind: 'finish',
              metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
            },
          } as RunFrame);
        }
        socket.emit({
          type: 'run-finished',
          runId: 'run-owned',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });
      await promise;

      expect(isLocalRun('conv-1', 'run-owned')).toBe(false);
    });

    it('flips isStreaming for the run duration and releases the socket', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));
      expect(result.current.isStreaming).toBe(false);

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });
      expect(result.current.isStreaming).toBe(true);

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      await act(async () => {
        finishRun(socket, capture);
        await promise;
      });

      expect(result.current.isStreaming).toBe(false);
      expect(sockets.acquireConversation).toHaveBeenCalledWith('conv-1');
      expect(sockets.releaseConversation).toHaveBeenCalledWith('conv-1');
    });

    it('attaches to a live same-key run when the POST returns attach', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ outcome: 'attach' }, 200));
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });

      const streamResult = await promise;
      expect(streamResult.outcome).toBe('succeeded');
    });

    it('treats a 200 with an unknown outcome value as a settled-run replay', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ outcome: 'persisted' }, 200));
      const onStart = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      let streamResult!: StreamResult;
      await act(async () => {
        streamResult = await result.current.startStream(baseRequest(), { onStart });
      });

      expect(streamResult.outcome).toBe('replayed');
      expect(onStart).not.toHaveBeenCalled();
    });

    it('carries wire details through a refusal', async () => {
      postSpies.chat.mockResolvedValue(
        jsonResponse({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 9 } }, 429)
      );
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(act(() => result.current.startStream(baseRequest()))).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds: 9 },
        status: 429,
      });
    });

    it('normalizes a null details field to undefined', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ code: 'FORBIDDEN', details: null }, 403));
      const { result } = renderHook(() => useChatStream('authenticated'));

      const error: unknown = await act(() =>
        result.current.startStream(baseRequest()).catch((error_: unknown) => error_)
      );

      expect(error).toBeInstanceOf(ChatRequestError);
      expect((error as ChatRequestError).code).toBe('FORBIDDEN');
      expect((error as ChatRequestError).details).toBeUndefined();
    });

    it('maps a refusal body with a non-string code to INTERNAL', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ code: 42 }, 500));
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(act(() => result.current.startStream(baseRequest()))).rejects.toMatchObject({
        code: 'INTERNAL',
        status: 500,
      });
    });

    it('maps an unparseable refusal body to INTERNAL', async () => {
      postSpies.chat.mockResolvedValue(new Response('gateway exploded', { status: 502 }));
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(act(() => result.current.startStream(baseRequest()))).rejects.toMatchObject({
        code: 'INTERNAL',
        status: 502,
      });
    });

    it('rejects an authenticated send with no models before POSTing', async () => {
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(() => result.current.startStream(baseRequest({ models: [] })))
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(postSpies.chat).not.toHaveBeenCalled();
    });

    it('sends the media modality and generation configs on the wire body', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          baseRequest({
            modality: 'video',
            imageConfig: { aspectRatio: '1:1' },
            videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
          }),
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.chat.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['modality']).toBe('video');
      expect(args.json['imageConfig']).toEqual({ aspectRatio: '1:1' });
      expect(args.json['videoConfig']).toEqual({
        aspectRatio: '16:9',
        durationSeconds: 5,
        resolution: '720p',
      });
    });

    it('forwards media lifecycle events for media modalities and ignores non-media ones', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const onModelMediaStart = vi.fn();
      const onModelMediaDone = vi.fn();
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onModelMediaStart,
          onModelMediaDone,
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      const assistantMessageId = capture.tiles[0]?.assistantMessageId;
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 1,
          event: { kind: 'stream-start', modelId: 'model-a' },
        } as RunFrame);
        for (const [cursor, modality] of (['image', 'audio', 'video', 'text'] as const).entries()) {
          socket.emit({
            type: 'stream',
            streamId: 's1',
            cursor: cursor + 2,
            event: { kind: 'media-start', index: 0, modality, mimeType: `${modality}/x` },
          } as RunFrame);
        }
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 6,
          event: {
            kind: 'media-done',
            index: 0,
            value: {
              ref: 'media/conv/msg/c1',
              mimeType: 'image/png',
              modality: 'image',
              byteLength: 1,
              metadata: {},
            },
          },
        } as RunFrame);
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 7,
          event: {
            kind: 'finish',
            metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
          },
        } as RunFrame);
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });
      await promise;

      expect(
        onModelMediaStart.mock.calls.map(([data]) => (data as { mediaType: string }).mediaType)
      ).toEqual(['image', 'audio', 'video']);
      expect(onModelMediaStart).toHaveBeenCalledWith({
        assistantMessageId,
        mediaType: 'image',
        mimeType: 'image/x',
      });
      expect(onModelMediaDone).toHaveBeenCalledWith({ assistantMessageId });
    });

    it('forwards media-progress percents to onModelMediaProgress', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const onModelMediaProgress = vi.fn();
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ modality: 'video' }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onModelMediaProgress,
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      const assistantMessageId = capture.tiles[0]?.assistantMessageId;
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 1,
          event: { kind: 'stream-start', modelId: 'model-a', outputModality: 'video' },
        } as RunFrame);
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 2,
          event: { kind: 'media-progress', index: 0, percent: 40 },
        } as RunFrame);
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 3,
          event: {
            kind: 'finish',
            metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
          },
        } as RunFrame);
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });
      await promise;

      expect(onModelMediaProgress).toHaveBeenCalledWith({ assistantMessageId, percent: 40 });
    });

    it('swaps the tile to generating from a stream-start with outputModality', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const onModelMediaStart = vi.fn();
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ modality: 'image' }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onModelMediaStart,
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      const assistantMessageId = capture.tiles[0]?.assistantMessageId;
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 1,
          event: { kind: 'stream-start', modelId: 'model-a', outputModality: 'image' },
        } as RunFrame);
      });
      expect(onModelMediaStart).toHaveBeenCalledWith({
        assistantMessageId,
        mediaType: 'image',
        mimeType: 'image/*',
      });
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 2,
          event: {
            kind: 'finish',
            metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
          },
        } as RunFrame);
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });
      await promise;
    });

    it('feeds only primary-tile tokens to an active TTS stream and ends it', async () => {
      const feed = vi.fn();
      const end = vi.fn();
      ttsMock.feeder = { feed, end };
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ models: ['model-a', 'model-b'] }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(2);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      // finishRun streams one 'Hi' token per tile; only the primary's reaches TTS.
      expect(feed).toHaveBeenCalledTimes(1);
      expect(feed).toHaveBeenCalledWith('Hi');
      expect(end).toHaveBeenCalledTimes(1);
      expect(ttsMock.probedMessageIds).toEqual([capture.tiles[0]?.assistantMessageId]);
    });

    it('rejects with a not-billed failure when the client-side deadline elapses', async () => {
      vi.useFakeTimers();
      try {
        postSpies.chat.mockResolvedValue(
          jsonResponse({ runId: 'run-1', deadlineAt: Date.now() + 60_000 }, 201)
        );
        const { result } = renderHook(() => useChatStream('authenticated'));

        let promise!: Promise<StreamResult>;
        act(() => {
          promise = result.current.startStream(baseRequest());
          armed(promise);
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(70_000);
        });

        await expect(promise).rejects.toMatchObject({
          name: 'ChatRunFailedError',
          code: 'CHAT_STREAM_FAILED',
          notBilled: true,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('regenerate', () => {
    it('POSTs the regenerate body through the typed route', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const request: RegenerateStreamRequest = {
        conversationId: 'conv-1',
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        replaceAssistantId: 'b1c0ce60-0000-4000-8000-000000000002',
        models: ['model-a'],
        userMessage: { id: 'user-msg-2', content: 'again' },
        messagesForInference: [{ role: 'user', content: 'again' }],
        fundingSource: 'personal_balance',
      };

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(request, {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args, init] = postSpies.regenerate.mock.calls[0] as [
        { json: Record<string, unknown> },
        { headers: Record<string, string> },
      ];
      expect(init.headers['Idempotency-Key']).toBeDefined();
      expect(args.json).toEqual({
        conversationId: 'conv-1',
        model: 'model-a',
        modality: 'text',
        models: ['model-a'],
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        replaceAssistantId: 'b1c0ce60-0000-4000-8000-000000000002',
        userMessage: { id: 'user-msg-2', content: 'again' },
        history: [],
      });
    });

    it('omits models for a Smart Model regenerate (sentinel rides the model anchor)', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const request: RegenerateStreamRequest = {
        conversationId: 'conv-1',
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        replaceAssistantId: 'b1c0ce60-0000-4000-8000-000000000002',
        models: [SMART_MODEL_ID],
        userMessage: { id: 'user-msg-2', content: 'again' },
        messagesForInference: [{ role: 'user', content: 'again' }],
        fundingSource: 'personal_balance',
      };

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(request, {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      // The server forbids a `models` list alongside the Smart Model sentinel
      // (the classifier picks the one answering model), so the sentinel rides
      // only the `model` anchor.
      expect(args.json['model']).toBe(SMART_MODEL_ID);
      expect(args.json).not.toHaveProperty('models');
    });

    it('sends the media modality and generation configs on the regenerate wire body', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const request: RegenerateStreamRequest = {
        conversationId: 'conv-1',
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        modality: 'video',
        models: ['video-model'],
        userMessage: { id: 'user-msg-2', content: 'again' },
        messagesForInference: [{ role: 'user', content: 'again' }],
        fundingSource: 'personal_balance',
        imageConfig: { aspectRatio: '1:1' },
        videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      };

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(request, {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['modality']).toBe('video');
      expect(args.json['imageConfig']).toEqual({ aspectRatio: '1:1' });
      expect(args.json['videoConfig']).toEqual({
        aspectRatio: '16:9',
        durationSeconds: 5,
        resolution: '720p',
      });
    });

    it('surfaces regenerate refusal codes', async () => {
      postSpies.regenerate.mockResolvedValue(jsonResponse({ code: 'FORK_ID_REQUIRED' }, 409));
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(() =>
          result.current.startRegenerateStream({
            conversationId: 'conv-1',
            targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
            action: 'retry',
            models: ['model-a'],
            userMessage: { id: 'u', content: 'again' },
            messagesForInference: [],
            fundingSource: 'personal_balance',
          })
        )
      ).rejects.toMatchObject({ code: 'FORK_ID_REQUIRED' });
    });

    it('rejects a regenerate with no models before POSTing', async () => {
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(() =>
          result.current.startRegenerateStream({
            conversationId: 'conv-1',
            targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
            action: 'retry',
            models: [],
            userMessage: { id: 'u', content: 'again' },
            messagesForInference: [],
            fundingSource: 'personal_balance',
          })
        )
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(postSpies.regenerate).not.toHaveBeenCalled();
      // No tiles exist, so the TTS binding probes an absent primary tile.
      expect(ttsMock.probedMessageIds).toEqual([null]);
    });

    it('sends models[] and forkId on a multi-model regenerate', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(
          {
            conversationId: 'conv-1',
            targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
            action: 'retry',
            models: ['model-a', 'model-b'],
            forkId: 'fork-9',
            userMessage: { id: 'u', content: 'again' },
            messagesForInference: [],
            fundingSource: 'personal_balance',
          },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(2);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['models']).toEqual(['model-a', 'model-b']);
      expect(args.json['forkId']).toBe('fork-9');
      expect(args.json['replaceAssistantId']).toBeUndefined();
    });
  });

  describe('trial', () => {
    it('sends prompt + history with the trial token and persists the returned session id', async () => {
      postSpies.trial.mockResolvedValue(
        jsonResponse(
          {
            runId: 'run-1',
            deadlineAt: Date.now() + 300_000,
            trialSessionId: 'session-from-server',
          },
          201
        )
      );
      const socket = sockets.trial as FakeSocket;
      const { result } = renderHook(() => useChatStream('trial'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          {
            model: 'model-t',
            messages: [
              { role: 'user', content: 'first' },
              { role: 'assistant', content: 'reply' },
              { role: 'user', content: 'second' },
            ],
          },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args, init] = postSpies.trial.mock.calls[0] as [
        { json: Record<string, unknown> },
        { headers: Record<string, string> },
      ];
      expect(init.headers['x-trial-token']).toMatch(/[0-9a-f-]{36}/);
      expect(init.headers['Idempotency-Key']).toBeDefined();
      expect(args.json).toEqual({
        model: 'model-t',
        prompt: 'second',
        history: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
        ],
      });
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'hushbox-trial-token',
        'session-from-server'
      );
      expect(sockets.acquireTrial).toHaveBeenCalled();
      expect(sockets.releaseTrial).toHaveBeenCalled();
    });

    it('throws refusal codes so trial-refusals can map them', async () => {
      postSpies.trial.mockResolvedValue(jsonResponse({ code: 'TRIAL_CAPACITY_REACHED' }, 429));
      const { result } = renderHook(() => useChatStream('trial'));

      await expect(
        act(() =>
          result.current.startStream({
            model: 'model-t',
            messages: [{ role: 'user', content: 'hi' }],
          })
        )
      ).rejects.toMatchObject({ code: 'TRIAL_CAPACITY_REACHED' });
    });

    it('rejects a trial send whose last message is not from the user', async () => {
      const { result } = renderHook(() => useChatStream('trial'));
      await expect(
        act(() =>
          result.current.startStream({
            model: 'model-t',
            messages: [{ role: 'assistant', content: 'hi' }],
          })
        )
      ).rejects.toBeInstanceOf(ChatRequestError);
      expect(postSpies.trial).not.toHaveBeenCalled();
    });

    it('keeps the minted token and sends webSearchEnabled when the 201 carries no session id', async () => {
      postSpies.trial.mockResolvedValue(
        jsonResponse({ runId: 'run-1', deadlineAt: Date.now() + 300_000 }, 201)
      );
      const socket = sockets.trial as FakeSocket;
      const { result } = renderHook(() => useChatStream('trial'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          {
            model: 'model-t',
            messages: [{ role: 'user', content: 'hi' }],
            webSearchEnabled: true,
          },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args, init] = postSpies.trial.mock.calls[0] as [
        { json: Record<string, unknown> },
        { headers: Record<string, string> },
      ];
      expect(args.json['webSearchEnabled']).toBe(true);
      // The only token write is the client-side mint that fed the request
      // header — a 201 without a session id persists nothing new.
      expect(localStorage.setItem).toHaveBeenCalledTimes(1);
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'hushbox-trial-token',
        init.headers['x-trial-token']
      );
    });

    it('returns replayed for a settled trial replay without firing onStart', async () => {
      postSpies.trial.mockResolvedValue(jsonResponse({ some: 'persisted-response' }, 200));
      const onStart = vi.fn();
      const { result } = renderHook(() => useChatStream('trial'));

      let streamResult!: StreamResult;
      await act(async () => {
        streamResult = await result.current.startStream(
          { model: 'model-t', messages: [{ role: 'user', content: 'hi' }] },
          { onStart }
        );
      });

      expect(streamResult.outcome).toBe('replayed');
      expect(onStart).not.toHaveBeenCalled();
    });
  });

  describe('stopRun', () => {
    it('POSTs the conversation id and returns the stopped flag', async () => {
      postSpies.stop.mockResolvedValue(jsonResponse({ stopped: true }, 200));
      const { result } = renderHook(() => useChatStream('authenticated'));

      const stopped = await act(() => result.current.stopRun('conv-1'));
      expect(stopped).toBe(true);
      const [args] = postSpies.stop.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json).toEqual({ conversationId: 'conv-1' });
    });

    it('returns false when the run already ended', async () => {
      postSpies.stop.mockResolvedValue(jsonResponse({ stopped: false }, 200));
      const { result } = renderHook(() => useChatStream('authenticated'));
      await expect(act(() => result.current.stopRun('conv-1'))).resolves.toBe(false);
    });

    it('returns false when the stop response body is unparseable', async () => {
      postSpies.stop.mockResolvedValue(new Response('', { status: 200 }));
      const { result } = renderHook(() => useChatStream('authenticated'));
      await expect(act(() => result.current.stopRun('conv-1'))).resolves.toBe(false);
    });

    it('throws ChatRequestError on a stop refusal', async () => {
      postSpies.stop.mockResolvedValue(jsonResponse({ code: 'FORBIDDEN' }, 403));
      const { result } = renderHook(() => useChatStream('authenticated'));
      await expect(act(() => result.current.stopRun('conv-1'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });
});
