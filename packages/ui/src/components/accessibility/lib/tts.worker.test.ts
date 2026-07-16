import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { WorkerOutbound } from './tts-worker-protocol';

const { generateMock, fromPretrainedMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  fromPretrainedMock: vi.fn(),
}));

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: fromPretrainedMock,
  },
}));

import { createWorkerHandler, type WorkerContext } from './tts.worker';

interface CapturedPost {
  msg: WorkerOutbound;
  transfer: Transferable[];
}

function captureContext(): { ctx: WorkerContext; posts: CapturedPost[] } {
  const posts: CapturedPost[] = [];
  return {
    posts,
    ctx: {
      postMessage(msg: WorkerOutbound, transfer: Transferable[] = []): void {
        posts.push({ msg, transfer });
      },
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createWorkerHandler', () => {
  beforeEach(() => {
    fromPretrainedMock.mockReset();
    generateMock.mockReset();
    fromPretrainedMock.mockResolvedValue({ generate: generateMock });
    generateMock.mockResolvedValue({
      audio: new Float32Array(100),
      sampling_rate: 24_000,
    });
  });

  describe('load', () => {
    it('calls KokoroTTS.from_pretrained with the documented model id, q8 dtype, and wasm device', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L1' });
      expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
      const [modelId, options] = fromPretrainedMock.mock.calls[0]!;
      expect(modelId).toBe('onnx-community/Kokoro-82M-v1.0-ONNX');
      expect(options.dtype).toBe('q8');
      expect(options.device).toBe('wasm');
      const types = posts.map((p) => p.msg.type);
      expect(types).toContain('loadDone');
    });

    it('posts loadDone with the matching requestId on success', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L42' });
      const done = posts.find((p) => p.msg.type === 'loadDone');
      expect(
        (done?.msg as Extract<WorkerOutbound, { type: 'loadDone' }> | undefined)?.requestId
      ).toBe('L42');
    });

    it('forwards kokoro progress events as loadProgress messages', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      let capturedProgressCallback: ((event: { loaded: number; total: number }) => void) | null =
        null;
      fromPretrainedMock.mockImplementationOnce((_id, options) => {
        capturedProgressCallback = options.progress_callback as typeof capturedProgressCallback;
        return Promise.resolve({ generate: generateMock });
      });
      await handler({ type: 'load', requestId: 'P1' });
      expect(capturedProgressCallback).not.toBeNull();
      capturedProgressCallback!({ loaded: 25, total: 100 });
      const progresses = posts.filter((p) => p.msg.type === 'loadProgress');
      expect(progresses).toHaveLength(1);
      const progressMsg = progresses[0]!.msg as Extract<WorkerOutbound, { type: 'loadProgress' }>;
      expect(progressMsg.loaded).toBe(25);
      expect(progressMsg.total).toBe(100);
      expect(progressMsg.requestId).toBe('P1');
    });

    it('ignores progress events without numeric loaded/total fields', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      let capturedProgressCallback: ((event: unknown) => void) | null = null;
      fromPretrainedMock.mockImplementationOnce((_id, options) => {
        capturedProgressCallback = options.progress_callback as typeof capturedProgressCallback;
        return Promise.resolve({ generate: generateMock });
      });
      await handler({ type: 'load', requestId: 'X1' });
      capturedProgressCallback!({ status: 'initiate' });
      capturedProgressCallback!({ status: 'progress', loaded: 10 });
      const progresses = posts.filter((p) => p.msg.type === 'loadProgress');
      expect(progresses).toHaveLength(0);
    });

    it('posts loadError when from_pretrained throws', async () => {
      fromPretrainedMock.mockRejectedValueOnce(new Error('network unreachable'));

      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'E1' });

      const errorMsg = posts.find((p) => p.msg.type === 'loadError');
      expect(errorMsg).toBeDefined();
      expect((errorMsg!.msg as Extract<WorkerOutbound, { type: 'loadError' }>).message).toContain(
        'network unreachable'
      );
    });

    it('does NOT post workerReady after loadDone — warmup is auto-issued next, workerReady waits for warmupDone', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L-NOREADY' });
      const loadDoneIndex = posts.findIndex((p) => p.msg.type === 'loadDone');
      const workerReadyAfter = posts
        .slice(loadDoneIndex + 1)
        .find((p) => p.msg.type === 'workerReady');
      expect(workerReadyAfter).toBeUndefined();
    });
  });

  describe('warmup', () => {
    it('calls tts.generate once and posts warmupDone without sending audio back', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockClear();
      await handler({ type: 'warmup', requestId: 'W1', voice: 'af_heart' });
      expect(generateMock).toHaveBeenCalledTimes(1);
      const [warmupText, warmupOptions] = generateMock.mock.calls[0]!;
      // Multi-word sentence with mixed punctuation: forces ORT to compile
      // more kernel-shape variants up front so the first real generation
      // doesn't pay a graph-compilation tax.
      expect(typeof warmupText).toBe('string');
      expect((warmupText as string).split(/\s+/).length).toBeGreaterThanOrEqual(5);
      expect(warmupText as string).toMatch(/[,;:]/);
      expect(warmupText as string).toMatch(/[.!?]$/);
      expect(warmupOptions).toEqual({ voice: 'af_heart' });
      const done = posts.find((p) => p.msg.type === 'warmupDone');
      expect(
        (done?.msg as Extract<WorkerOutbound, { type: 'warmupDone' }> | undefined)?.requestId
      ).toBe('W1');
      const ready = posts.find((p) => p.msg.type === 'speakReady');
      expect(ready).toBeUndefined();
    });

    it('posts workerReady after warmupDone so the engine can mark the slot idle', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      await handler({ type: 'warmup', requestId: 'WR1', voice: 'af_heart' });
      await flush();
      const warmupDoneIndex = posts.findIndex(
        (p) => p.msg.type === 'warmupDone' && p.msg.requestId === 'WR1'
      );
      expect(warmupDoneIndex).toBeGreaterThanOrEqual(0);
      const readyAfter = posts.slice(warmupDoneIndex + 1).find((p) => p.msg.type === 'workerReady');
      expect(readyAfter).toBeDefined();
    });

    it('posts workerReady after warmupError so the engine can mark the slot idle', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce(new Error('warmup boom'));
      await handler({ type: 'warmup', requestId: 'WR-ERR', voice: 'af_heart' });
      await flush();
      const errIndex = posts.findIndex(
        (p) => p.msg.type === 'warmupError' && p.msg.requestId === 'WR-ERR'
      );
      expect(errIndex).toBeGreaterThanOrEqual(0);
      const readyAfter = posts.slice(errIndex + 1).find((p) => p.msg.type === 'workerReady');
      expect(readyAfter).toBeDefined();
    });

    it('uses the voice passed in the warmup message so the user-selected voice embedding is fetched up front', async () => {
      const { ctx } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockClear();
      await handler({ type: 'warmup', requestId: 'W2', voice: 'am_michael' });
      expect(generateMock).toHaveBeenCalledTimes(1);
      const [, warmupOptions] = generateMock.mock.calls[0]!;
      expect(warmupOptions).toEqual({ voice: 'am_michael' });
    });

    it('posts warmupError if generate throws', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce(new Error('oom'));
      await handler({ type: 'warmup', requestId: 'W2', voice: 'af_heart' });
      const err = posts.find((p) => p.msg.type === 'warmupError');
      expect(err).toBeDefined();
      expect((err!.msg as Extract<WorkerOutbound, { type: 'warmupError' }>).message).toContain(
        'oom'
      );
    });
  });

  describe('speak', () => {
    it('calls generate with the requested text and voice', async () => {
      const { ctx } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockClear();
      await handler({ type: 'speak', requestId: 'S1', text: 'hello', voice: 'af_heart' });
      await flush();
      expect(generateMock).toHaveBeenCalledWith('hello', { voice: 'af_heart' });
    });

    it('posts speakReady with the audio buffer as transferable', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      const audio = new Float32Array(64);
      generateMock.mockResolvedValueOnce({ audio, sampling_rate: 24_000 });
      await handler({ type: 'speak', requestId: 'S2', text: 'go', voice: 'af_heart' });
      await flush();
      const ready = posts.find((p) => p.msg.type === 'speakReady');
      expect(ready).toBeDefined();
      const readyMsg = ready!.msg as Extract<WorkerOutbound, { type: 'speakReady' }>;
      expect(readyMsg.requestId).toBe('S2');
      expect(readyMsg.samplingRate).toBe(24_000);
      expect(readyMsg.audio).toBe(audio);
      expect(ready!.transfer).toContain(audio.buffer);
    });

    it('processes speak messages sequentially in enqueue order', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });

      const order: string[] = [];
      generateMock.mockImplementation(async (text: string) => {
        order.push(`start:${text}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${text}`);
        return { audio: new Float32Array(10), sampling_rate: 24_000 };
      });

      await handler({ type: 'speak', requestId: 'A', text: 'a', voice: 'af_heart' });
      await handler({ type: 'speak', requestId: 'B', text: 'b', voice: 'af_heart' });
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Sequential: 'a' must finish before 'b' starts.
      expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
      const readys = posts
        .filter((p) => p.msg.type === 'speakReady')
        .map((r) => r.msg as Extract<WorkerOutbound, { type: 'speakReady' }>);
      expect(readys.map((r) => r.requestId)).toEqual(['A', 'B']);
    });

    it('posts speakError when generate throws', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce(new Error('inference died'));
      await handler({ type: 'speak', requestId: 'E', text: 'x', voice: 'af_heart' });
      await flush();
      const err = posts.find((p) => p.msg.type === 'speakError');
      expect(err).toBeDefined();
      const errMsg = err!.msg as Extract<WorkerOutbound, { type: 'speakError' }>;
      expect(errMsg.requestId).toBe('E');
      expect(errMsg.message).toContain('inference died');
    });

    it('posts workerReady after speakReady so the engine can dispatch the next queued sentence', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      await handler({ type: 'speak', requestId: 'SR1', text: 'a', voice: 'af_heart' });
      await flush();
      const readyIndex = posts.findIndex(
        (p) => p.msg.type === 'speakReady' && p.msg.requestId === 'SR1'
      );
      expect(readyIndex).toBeGreaterThanOrEqual(0);
      const workerReadyAfter = posts
        .slice(readyIndex + 1)
        .find((p) => p.msg.type === 'workerReady');
      expect(workerReadyAfter).toBeDefined();
    });

    it('posts workerReady after speakError so the engine still marks the slot idle on failure', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce(new Error('boom'));
      await handler({ type: 'speak', requestId: 'SE1', text: 'x', voice: 'af_heart' });
      await flush();
      const errIndex = posts.findIndex(
        (p) => p.msg.type === 'speakError' && p.msg.requestId === 'SE1'
      );
      expect(errIndex).toBeGreaterThanOrEqual(0);
      const workerReadyAfter = posts.slice(errIndex + 1).find((p) => p.msg.type === 'workerReady');
      expect(workerReadyAfter).toBeDefined();
    });
  });

  describe('cancel', () => {
    it('drops a cancelled request before generation starts', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });

      let blockerResolve: (() => void) | null = null;
      const blocker = new Promise<void>((resolve) => {
        blockerResolve = resolve;
      });
      generateMock.mockImplementationOnce(async () => {
        await blocker;
        return { audio: new Float32Array(10), sampling_rate: 24_000 };
      });
      generateMock.mockResolvedValue({ audio: new Float32Array(10), sampling_rate: 24_000 });

      // First speak starts immediately; second is queued behind it.
      await handler({ type: 'speak', requestId: 'A', text: 'a', voice: 'af_heart' });
      await handler({ type: 'speak', requestId: 'B', text: 'b', voice: 'af_heart' });
      await handler({ type: 'cancel', requestId: 'B' });

      blockerResolve!();
      await flush();
      await flush();

      const readys = posts
        .filter((p) => p.msg.type === 'speakReady')
        .map((r) => r.msg as Extract<WorkerOutbound, { type: 'speakReady' }>);
      const readyIds = readys.map((r) => r.requestId);
      expect(readyIds).toContain('A');
      expect(readyIds).not.toContain('B');
    });

    it('drops the audio result of a cancelled in-flight generation', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });

      let blockerResolve: (() => void) | null = null;
      const blocker = new Promise<void>((resolve) => {
        blockerResolve = resolve;
      });
      generateMock.mockImplementationOnce(async () => {
        await blocker;
        return { audio: new Float32Array(10), sampling_rate: 24_000 };
      });

      await handler({ type: 'speak', requestId: 'C', text: 'c', voice: 'af_heart' });
      await handler({ type: 'cancel', requestId: 'C' });
      blockerResolve!();
      await flush();
      await flush();

      const ready = posts.find((p) => p.msg.type === 'speakReady' && p.msg.requestId === 'C');
      expect(ready).toBeUndefined();
    });

    it('posts workerReady once a cancelled speak finishes draining (no speakReady, still ready signal)', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });

      let blockerResolve: (() => void) | null = null;
      const blocker = new Promise<void>((resolve) => {
        blockerResolve = resolve;
      });
      generateMock.mockImplementationOnce(async () => {
        await blocker;
        return { audio: new Float32Array(10), sampling_rate: 24_000 };
      });

      const readyCountBefore = posts.filter((p) => p.msg.type === 'workerReady').length;
      await handler({ type: 'speak', requestId: 'CWR', text: 'c', voice: 'af_heart' });
      await handler({ type: 'cancel', requestId: 'CWR' });
      blockerResolve!();
      await flush();
      await flush();

      const readyCountAfter = posts.filter((p) => p.msg.type === 'workerReady').length;
      expect(readyCountAfter).toBe(readyCountBefore + 1);
      const speakReady = posts.find(
        (p) => p.msg.type === 'speakReady' && p.msg.requestId === 'CWR'
      );
      expect(speakReady).toBeUndefined();
    });
  });

  describe('before the engine is loaded', () => {
    it('warmup reports the engine is not loaded and signals worker-ready', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'warmup', requestId: 'W0', voice: 'af_heart' });
      await flush();
      const warmupError = posts.find((p) => p.msg.type === 'warmupError');
      expect(warmupError?.msg).toMatchObject({
        requestId: 'W0',
        message: 'TTS engine is not loaded',
      });
      expect(posts.some((p) => p.msg.type === 'workerReady')).toBe(true);
    });

    it('speak reports the engine is not loaded', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      void handler({ type: 'speak', requestId: 'S0', text: 'hi', voice: 'af_heart' });
      await flush();
      const speakError = posts.find((p) => p.msg.type === 'speakError');
      expect(speakError?.msg).toMatchObject({
        requestId: 'S0',
        message: 'TTS engine is not loaded',
      });
    });
  });

  describe('stringifies non-Error rejections', () => {
    it('load reports a stringified non-Error failure', async () => {
      fromPretrainedMock.mockRejectedValueOnce('kaboom');
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L9' });
      const loadError = posts.find((p) => p.msg.type === 'loadError');
      expect(loadError?.msg).toMatchObject({ requestId: 'L9', message: 'kaboom' });
    });

    it('warmup reports a stringified non-Error failure', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce('warm-boom');
      await handler({ type: 'warmup', requestId: 'W9', voice: 'af_heart' });
      const warmupError = posts.find((p) => p.msg.type === 'warmupError');
      expect(warmupError?.msg).toMatchObject({ requestId: 'W9', message: 'warm-boom' });
    });

    it('speak reports a stringified non-Error failure', async () => {
      const { ctx, posts } = captureContext();
      const handler = createWorkerHandler(ctx);
      await handler({ type: 'load', requestId: 'L' });
      generateMock.mockRejectedValueOnce('speak-boom');
      void handler({ type: 'speak', requestId: 'S9', text: 'hi', voice: 'af_heart' });
      await flush();
      const speakError = posts.find((p) => p.msg.type === 'speakError');
      expect(speakError?.msg).toMatchObject({ requestId: 'S9', message: 'speak-boom' });
    });
  });
});

describe('worker auto-registration', () => {
  it('registers a message listener and wires postMessage when running inside a worker', async () => {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const originalImportScripts = (globalThis as { importScripts?: unknown }).importScripts;
    const originalPostMessage = globalThis.postMessage;
    const originalAdd = self.addEventListener;
    const posted: unknown[] = [];
    (globalThis as { importScripts?: unknown }).importScripts = (): void => {};
    globalThis.postMessage = ((msg: unknown): void => {
      posted.push(msg);
    }) as typeof globalThis.postMessage;
    self.addEventListener = ((type: string, listener: (event: MessageEvent) => void): void => {
      if (type === 'message') listeners.push(listener);
    }) as typeof globalThis.addEventListener;
    fromPretrainedMock.mockResolvedValue({ generate: generateMock });
    try {
      vi.resetModules();
      await import('./tts.worker');
      expect(listeners.length).toBe(1);
      // Drive a message through the registered listener; the worker context's
      // postMessage forwards to the global postMessage.
      listeners[0]!({ data: { type: 'load', requestId: 'AR' } } as MessageEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(posted.length).toBeGreaterThan(0);
    } finally {
      if (originalImportScripts === undefined) {
        Reflect.deleteProperty(globalThis as object, 'importScripts');
      } else {
        (globalThis as { importScripts?: unknown }).importScripts = originalImportScripts;
      }
      globalThis.postMessage = originalPostMessage;
      self.addEventListener = originalAdd;
    }
  });
});
