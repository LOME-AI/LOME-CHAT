import { describe, it, expect, vi } from 'vitest';
import { executeChatRun } from '@/lib/chat-run.js';
import { ChatRequestError } from '@/lib/chat-request-error.js';
import type { RunFrame } from '@/lib/server-frames.js';
import type { ChatRunCallbacks, RunStartResponse, RunTransportSocket } from '@/lib/chat-run.js';

interface FakeSocket extends RunTransportSocket {
  emit(frame: RunFrame): void;
  setReady(value: boolean): void;
}

function createFakeSocket(initialReady = true): FakeSocket {
  const frameListeners = new Set<(frame: RunFrame) => void>();
  const stateListeners = new Set<() => void>();
  let ready = initialReady;
  return {
    connect: vi.fn(),
    waitForReady: (): Promise<boolean> => Promise.resolve(ready),
    get ready(): boolean {
      return ready;
    },
    onRunFrame(listener: (frame: RunFrame) => void): () => void {
      frameListeners.add(listener);
      return (): void => {
        frameListeners.delete(listener);
      };
    },
    onStateChange(listener: () => void): () => void {
      stateListeners.add(listener);
      return (): void => {
        stateListeners.delete(listener);
      };
    },
    emit(frame: RunFrame): void {
      for (const listener of frameListeners) listener(frame);
    },
    setReady(value: boolean): void {
      ready = value;
      for (const listener of stateListeners) listener();
    },
  };
}

function stream(streamId: string, cursor: number, event: unknown): RunFrame {
  return { type: 'stream', streamId, cursor, event } as RunFrame;
}

const started = (runId = 'run-1', deadlineAt = Date.now() + 300_000): RunStartResponse => ({
  kind: 'started',
  runId,
  deadlineAt,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const finishEvent = (finishReason = 'stop'): unknown => ({
  kind: 'finish',
  metadata: {
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason,
  },
});

function runFinished(outcome: unknown, runId = 'run-1'): RunFrame {
  return { type: 'run-finished', runId, outcome } as RunFrame;
}

describe('executeChatRun', () => {
  it('streams a single-model turn to completion', async () => {
    const socket = createFakeSocket();
    const tokens: [string, string][] = [];
    const callbacks: ChatRunCallbacks = {
      onRunStarted: vi.fn(),
      onModelResolved: vi.fn(),
      onToken: (token, id) => tokens.push([token, id]),
      onModelDone: vi.fn(),
      onAllModelsComplete: vi.fn(),
    };
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks,
    });
    await flush();

    socket.emit({ type: 'run-started', runId: 'run-1' });
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'Hel' }));
    socket.emit(stream('s1', 3, { kind: 'text-delta', index: 0, content: 'lo' }));
    socket.emit(stream('s1', 4, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(result).toEqual({
      outcome: 'succeeded',
      models: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
    });
    expect(callbacks.onRunStarted).toHaveBeenCalledWith('run-1');
    expect(callbacks.onModelResolved).toHaveBeenCalledWith('tile-1', 'model-a');
    expect(tokens).toEqual([
      ['Hel', 'tile-1'],
      ['lo', 'tile-1'],
    ]);
    expect(callbacks.onModelDone).toHaveBeenCalledWith({
      assistantMessageId: 'tile-1',
      modelId: 'model-a',
    });
    expect(callbacks.onAllModelsComplete).toHaveBeenCalledTimes(1);
  });

  it('demuxes interleaved multi-model streams by stream-start model id', async () => {
    const socket = createFakeSocket();
    const tokens: [string, string][] = [];
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [
        { modelId: 'model-a', assistantMessageId: 'tile-a' },
        { modelId: 'model-b', assistantMessageId: 'tile-b' },
      ],
      callbacks: { onToken: (token, id) => tokens.push([token, id]) },
    });
    await flush();

    // model-b's stream starts first — binding is by model id, not arrival order
    socket.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'model-b' }));
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s2', 2, { kind: 'text-delta', index: 0, content: 'B' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'A' }));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(stream('s2', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(tokens).toEqual([
      ['B', 'tile-b'],
      ['A', 'tile-a'],
    ]);
    expect(result.outcome).toBe('succeeded');
  });

  it('binds an unmatched stream to the first unbound tile (Smart Model resolution)', async () => {
    const socket = createFakeSocket();
    const onModelResolved = vi.fn();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'smart-model', assistantMessageId: 'tile-1' }],
      callbacks: { onModelResolved },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'openai/gpt-4o' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(onModelResolved).toHaveBeenCalledWith('tile-1', 'openai/gpt-4o');
    if (result.outcome !== 'succeeded') throw new Error('expected success');
    expect(result.models).toEqual([{ modelId: 'openai/gpt-4o', assistantMessageId: 'tile-1' }]);
  });

  it('routes reasoning deltas separately and tolerates tool/step events', async () => {
    const socket = createFakeSocket();
    const reasoning: [string, string][] = [];
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: { onReasoningToken: (token, id) => reasoning.push([token, id]) },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'reasoning-delta', index: 0, content: 'thinking' }));
    socket.emit(stream('s1', 3, { kind: 'tool-call', id: 't1', name: 'search', args: {} }));
    socket.emit(stream('s1', 4, { kind: 'tool-result', id: 't1', name: 'search', result: {} }));
    socket.emit(stream('s1', 5, { kind: 'step-start', step: 0 }));
    socket.emit(stream('s1', 6, { kind: 'step-finish', step: 0, generationId: 'g1' }));
    socket.emit(stream('s1', 7, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
    expect(reasoning).toEqual([['thinking', 'tile-1']]);
  });

  it('surfaces media-start and media-done for a media stream', async () => {
    const socket = createFakeSocket();
    const onMediaStart = vi.fn();
    const onMediaDone = vi.fn();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'image-model', assistantMessageId: 'tile-1' }],
      callbacks: { onMediaStart, onMediaDone },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'image-model' }));
    socket.emit(
      stream('s1', 2, { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' })
    );
    socket.emit(
      stream('s1', 3, {
        kind: 'media-done',
        index: 0,
        value: { ref: 'r', mimeType: 'image/png', modality: 'image', byteLength: 5, metadata: {} },
      })
    );
    socket.emit(stream('s1', 4, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(onMediaStart).toHaveBeenCalledWith({
      assistantMessageId: 'tile-1',
      mediaType: 'image',
      mimeType: 'image/png',
    });
    expect(onMediaDone).toHaveBeenCalledWith({ assistantMessageId: 'tile-1' });
  });

  it('marks a stream finishing with reason error as a model error', async () => {
    const socket = createFakeSocket();
    const onModelError = vi.fn();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [
        { modelId: 'model-a', assistantMessageId: 'tile-a' },
        { modelId: 'model-b', assistantMessageId: 'tile-b' },
      ],
      callbacks: { onModelError },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'model-b' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(stream('s2', 2, finishEvent('error')));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(onModelError).toHaveBeenCalledWith({
      assistantMessageId: 'tile-b',
      modelId: 'model-b',
      code: 'STREAM_ERROR',
    });
    if (result.outcome !== 'succeeded') throw new Error('expected success');
    expect(result.models[1]).toEqual({
      modelId: 'model-b',
      assistantMessageId: 'tile-b',
      errorCode: 'STREAM_ERROR',
    });
  });

  it('marks a tile that never streamed as errored when the run succeeds', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [
        { modelId: 'model-a', assistantMessageId: 'tile-a' },
        { modelId: 'model-b', assistantMessageId: 'tile-b' },
      ],
      callbacks: {},
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    if (result.outcome !== 'succeeded') throw new Error('expected success');
    expect(result.models[1]?.errorCode).toBe('STREAM_ERROR');
  });

  it('does not mark unfinished tiles as errored when the run is stopped', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'partial' }));
    socket.emit(runFinished({ outcome: 'stopped' }));

    const result = await promise;
    if (result.outcome !== 'stopped') throw new Error('expected stopped');
    expect(result.models[0]?.errorCode).toBeUndefined();
  });

  it('returns replayed for a settled-run replay response without waiting for frames', async () => {
    const socket = createFakeSocket();
    const result = await executeChatRun({
      socket,
      postRun: () => Promise.resolve({ kind: 'replay' }),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    expect(result).toEqual({ outcome: 'replayed' });
  });

  it('returns failed with the code when the run fails', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.emit(runFinished({ outcome: 'failed', code: 'INTERNAL' }));

    const result = await promise;
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed');
    expect(result.code).toBe('INTERNAL');
  });

  it('ignores a run-finished frame for a different run', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started('run-1')),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.emit(runFinished({ outcome: 'failed', code: 'INTERNAL' }, 'other-run'));
    socket.emit(runFinished({ outcome: 'succeeded' }, 'run-1'));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
  });

  it('rethrows a refusal from the run-start POST', async () => {
    const socket = createFakeSocket();
    await expect(
      executeChatRun({
        socket,
        postRun: () => Promise.reject(new ChatRequestError('CONCURRENT_RUN')),
        tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
        callbacks: {},
      })
    ).rejects.toMatchObject({ code: 'CONCURRENT_RUN' });
  });

  it('fails without posting when the socket never becomes ready', async () => {
    const socket = createFakeSocket(false);
    socket.waitForReady = (): Promise<boolean> => Promise.resolve(false);
    const postRun = vi.fn();
    const result = await executeChatRun({
      socket,
      postRun: postRun as unknown as () => Promise<RunStartResponse>,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    expect(postRun).not.toHaveBeenCalled();
    expect(result.outcome).toBe('failed');
  });

  it('buffers frames that land before the POST resolves', async () => {
    const socket = createFakeSocket();
    const tokens: string[] = [];
    let resolvePost!: (r: RunStartResponse) => void;
    const promise = executeChatRun({
      socket,
      postRun: () =>
        new Promise<RunStartResponse>((resolve) => {
          resolvePost = resolve;
        }),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onToken: (token) => tokens.push(token) },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'early' }));
    expect(tokens).toEqual([]);

    resolvePost(started());
    await flush();
    expect(tokens).toEqual(['early']);

    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));
    await promise;
  });

  it('fails as deadline when the client-side deadline elapses with no terminal frame', async () => {
    vi.useFakeTimers();
    try {
      const socket = createFakeSocket();
      const promise = executeChatRun({
        socket,
        postRun: () => Promise.resolve(started('run-1', Date.now() + 60_000)),
        tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
        callbacks: {},
        deadlineGraceMs: 1000,
      });
      await flush();

      vi.advanceTimersByTime(61_001);

      const result = await promise;
      expect(result.outcome).toBe('deadline');
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-resubmits once on reconnect and attaches to the live run', async () => {
    const socket = createFakeSocket();
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce({ kind: 'attach' });
    const promise = executeChatRun({
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.setReady(false);
    socket.setReady(true);
    await flush();
    expect(postRun).toHaveBeenCalledTimes(2);

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));
    const result = await promise;
    expect(result.outcome).toBe('succeeded');
  });

  it('treats a replay on resubmit as the settled outcome', async () => {
    const socket = createFakeSocket();
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce({ kind: 'replay' });
    const promise = executeChatRun({
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.setReady(false);
    socket.setReady(true);
    await flush();

    const result = await promise;
    expect(result.outcome).toBe('replayed');
  });

  it('resets tiles and rebinds when a resubmit starts a clean re-execution', async () => {
    const socket = createFakeSocket();
    const onRestart = vi.fn();
    const tokens: string[] = [];
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started('run-1'))
      .mockResolvedValueOnce(started('run-2'));
    const promise = executeChatRun({
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onRestart, onToken: (token) => tokens.push(token) },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'first' }));

    socket.setReady(false);
    socket.setReady(true);
    await flush();
    expect(onRestart).toHaveBeenCalledWith(['tile-a']);

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'second' }));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }, 'run-2'));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
    expect(tokens).toEqual(['first', 'second']);
  });

  it('surfaces an error after the resubmit budget is exhausted', async () => {
    const socket = createFakeSocket();
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce({ kind: 'attach' });
    const promise = executeChatRun({
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.setReady(false);
    socket.setReady(true);
    await flush();
    socket.setReady(false);
    socket.setReady(true);
    await flush();

    const result = await promise;
    expect(result.outcome).toBe('failed');
    expect(postRun).toHaveBeenCalledTimes(2);
  });

  it('settles with the first terminal outcome when run-finished arrives twice', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.emit(runFinished({ outcome: 'stopped' }));
    socket.emit(runFinished({ outcome: 'failed', code: 'INTERNAL' }));

    const result = await promise;
    expect(result.outcome).toBe('stopped');
  });

  it('ignores streams beyond the tile allocation', async () => {
    const socket = createFakeSocket();
    const tokens: string[] = [];
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onToken: (token) => tokens.push(token) },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'model-b' }));
    socket.emit(stream('s2', 2, { kind: 'text-delta', index: 0, content: 'orphan' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'kept' }));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(tokens).toEqual(['kept']);
    if (result.outcome !== 'succeeded') throw new Error('expected success');
    expect(result.models).toEqual([{ modelId: 'model-a', assistantMessageId: 'tile-a' }]);
  });

  it('reports a tile done once even when its finish event is replayed', async () => {
    const socket = createFakeSocket();
    const onModelDone = vi.fn();
    const onAllModelsComplete = vi.fn();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onModelDone, onAllModelsComplete },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(onModelDone).toHaveBeenCalledTimes(1);
    expect(onAllModelsComplete).toHaveBeenCalledTimes(1);
  });

  it('attaches to a live run when the initial POST returns attach', async () => {
    const socket = createFakeSocket();
    const tokens: string[] = [];
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve({ kind: 'attach' }),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onToken: (token) => tokens.push(token) },
    });
    await flush();

    socket.emit({ type: 'run-started', runId: 'run-live' } as RunFrame);
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'live' }));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }, 'run-live'));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
    expect(tokens).toEqual(['live']);
  });

  it.each([
    ['a coded refusal', new ChatRequestError('CONCURRENT_RUN'), 'CONCURRENT_RUN'],
    ['a plain Error', new Error('boom'), 'CHAT_STREAM_FAILED'],
    ['a non-string code', { code: 42 }, 'CHAT_STREAM_FAILED'],
    ['a primitive', 'boom', 'CHAT_STREAM_FAILED'],
    ['null', null, 'CHAT_STREAM_FAILED'],
  ])(
    'fails the run with the extracted code when the reconnect resubmit rejects with %s',
    async (_label, rejection, expectedCode) => {
      const socket = createFakeSocket();
      const postRun = vi
        .fn<() => Promise<RunStartResponse>>()
        .mockResolvedValueOnce(started())
        .mockRejectedValueOnce(rejection);
      const promise = executeChatRun({
        socket,
        postRun,
        tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
        callbacks: {},
      });
      await flush();

      socket.setReady(false);
      socket.setReady(true);
      await flush();

      const result = await promise;
      expect(result.outcome).toBe('failed');
      if (result.outcome !== 'failed') throw new Error('expected failed');
      expect(result.code).toBe(expectedCode);
    }
  );

  it('discards a resubmit response that lands after the run already settled', async () => {
    const socket = createFakeSocket();
    const onRestart = vi.fn();
    let resolveSecond!: (response: RunStartResponse) => void;
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started())
      .mockImplementationOnce(
        () =>
          new Promise<RunStartResponse>((resolve) => {
            resolveSecond = resolve;
          })
      );
    const promise = executeChatRun({
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onRestart },
    });
    await flush();

    socket.setReady(false);
    socket.setReady(true);
    await flush();

    socket.emit(runFinished({ outcome: 'succeeded' }));
    resolveSecond(started('run-2'));
    await flush();

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('tolerates stream-gone without corrupting the run', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit({ type: 'stream-gone', streamId: 's1' });
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
  });
});
