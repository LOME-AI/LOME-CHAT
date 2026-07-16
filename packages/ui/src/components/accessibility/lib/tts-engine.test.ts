import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  TTS_VOICES,
  WORKER_POOL_SIZE,
  getTtsService,
  _resetTtsServiceForTesting,
  _setWorkerFactoryForTesting,
  _setLoadTimeoutMsForTesting,
  type TtsVoice,
} from './tts-engine';

import type { WorkerInbound, WorkerOutbound } from './tts-worker-protocol';

class FakeWorker extends EventTarget {
  postMessage = vi.fn<(msg: WorkerInbound, transfer?: Transferable[]) => void>();
  terminate = vi.fn<() => void>();

  send(msg: WorkerOutbound, _transfer: Transferable[] = []): void {
    this.dispatchEvent(new MessageEvent('message', { data: msg }));
  }

  crash(message = 'worker crashed'): void {
    this.dispatchEvent(new ErrorEvent('error', { message }));
  }

  sendMessageError(): void {
    this.dispatchEvent(new MessageEvent('messageerror'));
  }
}

function lastInboundOfType<T extends WorkerInbound['type']>(
  worker: FakeWorker,
  type: T
): Extract<WorkerInbound, { type: T }> | undefined {
  for (let index = worker.postMessage.mock.calls.length - 1; index >= 0; index--) {
    const [msg] = worker.postMessage.mock.calls[index]!;
    if (msg.type === type) return msg as Extract<WorkerInbound, { type: T }>;
  }
  return undefined;
}

function countInboundOfType(worker: FakeWorker, type: WorkerInbound['type']): number {
  return worker.postMessage.mock.calls.filter(([m]) => m.type === type).length;
}

describe('TTS_VOICES', () => {
  it('contains the five expected voice ids in the documented order', () => {
    const ids = TTS_VOICES.map((v) => v.id);
    expect(ids).toEqual(['af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_nicole']);
  });

  it('every entry has displayName, accent, and gender', () => {
    for (const voice of TTS_VOICES) {
      expect(voice.displayName).toBeTypeOf('string');
      expect(voice.displayName.length).toBeGreaterThan(0);
      expect(['American', 'British']).toContain(voice.accent);
      expect(['female', 'male']).toContain(voice.gender);
    }
  });

  it('marks af_heart as American female "Heart"', () => {
    const heart = TTS_VOICES.find((v) => v.id === 'af_heart');
    expect(heart).toEqual({
      id: 'af_heart',
      displayName: 'Heart',
      accent: 'American',
      gender: 'female',
    });
  });
});

describe('WORKER_POOL_SIZE', () => {
  it('is a small positive integer (single local constant controlling pool width)', () => {
    expect(Number.isInteger(WORKER_POOL_SIZE)).toBe(true);
    expect(WORKER_POOL_SIZE).toBeGreaterThan(0);
    expect(WORKER_POOL_SIZE).toBeLessThanOrEqual(8);
  });

  it('is 4 (locks the current tuning so a stray edit is caught in review)', () => {
    expect(WORKER_POOL_SIZE).toBe(4);
  });
});

describe('getTtsService singleton', () => {
  beforeEach(() => {
    _resetTtsServiceForTesting();
    _setWorkerFactoryForTesting(() => new FakeWorker() as unknown as Worker);
  });

  afterEach(() => {
    _resetTtsServiceForTesting();
    _setWorkerFactoryForTesting(null);
  });

  it('returns the same instance across multiple calls', () => {
    const a = getTtsService();
    const b = getTtsService();
    expect(a).toBe(b);
  });

  it('_resetTtsServiceForTesting clears the singleton so a fresh instance is returned', () => {
    const a = getTtsService();
    _resetTtsServiceForTesting();
    const b = getTtsService();
    expect(a).not.toBe(b);
  });
});

describe('WorkerKokoroTtsService', () => {
  interface CapturedSource {
    buffer: AudioBuffer | null;
    onended: ((this: AudioBufferSourceNode, event: Event) => unknown) | null;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    triggerEnded(): void;
  }

  interface CapturedAudioCtx {
    state: AudioContextState;
    currentTime: number;
    createBuffer: ReturnType<typeof vi.fn>;
    createBufferSource: ReturnType<typeof vi.fn>;
    decodeAudioData: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    destination: AudioDestinationNode;
  }

  let createdContexts: CapturedAudioCtx[];
  let createdSources: CapturedSource[];
  let createdWorkers: FakeWorker[];
  const OriginalAudioContext = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;

  function makeAudioContext(): CapturedAudioCtx {
    const ctx: CapturedAudioCtx = {
      state: 'suspended',
      currentTime: 0,
      createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => {
        return {
          length,
          sampleRate,
          numberOfChannels: _channels,
          duration: length / sampleRate,
          copyToChannel: vi.fn(),
          getChannelData: vi.fn(),
          copyFromChannel: vi.fn(),
        };
      }),
      createBufferSource: vi.fn(() => {
        const endedListeners: ((event: Event) => void)[] = [];
        const source: CapturedSource = {
          buffer: null,
          onended(this: AudioBufferSourceNode, event: Event) {
            for (const listener of endedListeners) listener(event);
          },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
          addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
            if (type === 'ended') endedListeners.push(listener);
          }),
          removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
            if (type !== 'ended') return;
            const index = endedListeners.indexOf(listener);
            if (index !== -1) endedListeners.splice(index, 1);
          }),
          triggerEnded(): void {
            for (const listener of endedListeners) listener(new Event('ended'));
          },
        };
        createdSources.push(source);
        return source as unknown as AudioBufferSourceNode;
      }),
      decodeAudioData: vi.fn(),
      resume: vi.fn(() => {
        ctx.state = 'running';
        return Promise.resolve();
      }),
      close: vi.fn(() => {
        ctx.state = 'closed';
        return Promise.resolve();
      }),
      destination: {} as AudioDestinationNode,
    };
    createdContexts.push(ctx);
    return ctx;
  }

  async function ackLoadOn(worker: FakeWorker): Promise<void> {
    const msg = lastInboundOfType(worker, 'load');
    if (msg) worker.send({ type: 'loadDone', requestId: msg.requestId });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function ackWarmupOn(worker: FakeWorker): Promise<void> {
    const msg = lastInboundOfType(worker, 'warmup');
    if (msg) {
      worker.send({ type: 'warmupDone', requestId: msg.requestId });
      worker.send({ type: 'workerReady' });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function completeLoad(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const worker of createdWorkers) await ackLoadOn(worker);
    for (const worker of createdWorkers) await ackWarmupOn(worker);
  }

  function ackSpeakOn(worker: FakeWorker, audioLength: number, samplingRate = 24_000): string {
    const msg = lastInboundOfType(worker, 'speak')!;
    worker.send({
      type: 'speakReady',
      requestId: msg.requestId,
      audio: new Float32Array(audioLength),
      samplingRate,
    });
    worker.send({ type: 'workerReady' });
    return msg.requestId;
  }

  beforeEach(() => {
    _resetTtsServiceForTesting();
    createdContexts = [];
    createdSources = [];
    createdWorkers = [];
    _setWorkerFactoryForTesting(() => {
      const w = new FakeWorker();
      createdWorkers.push(w);
      return w as unknown as Worker;
    });
    (globalThis as { AudioContext?: unknown }).AudioContext = vi.fn(makeAudioContext);
  });

  afterEach(() => {
    _resetTtsServiceForTesting();
    _setWorkerFactoryForTesting(null);
    _setLoadTimeoutMsForTesting(null);
    if (OriginalAudioContext === undefined) {
      delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    } else {
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext = OriginalAudioContext;
    }
  });

  it('isLoaded() returns false before load()', () => {
    const service = getTtsService();
    expect(service.isLoaded()).toBe(false);
  });

  it('load() spawns WORKER_POOL_SIZE workers and posts a load message to every one', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createdWorkers).toHaveLength(WORKER_POOL_SIZE);
    for (const worker of createdWorkers) {
      expect(countInboundOfType(worker, 'load')).toBe(1);
    }
    await completeLoad();
    await loadPromise;
    expect(service.isLoaded()).toBe(true);
  });

  it('load() resolves only after every worker reports both loadDone and warmupDone', async () => {
    const service = getTtsService();
    let resolved = false;
    /* eslint-disable promise/prefer-await-to-then, promise/always-return -- observe resolution without awaiting */
    service
      .load('af_heart')
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    /* eslint-enable promise/prefer-await-to-then, promise/always-return */
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Ack loadDone on all but the last worker.
    for (let index = 0; index < createdWorkers.length - 1; index++) {
      await ackLoadOn(createdWorkers[index]!);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Engine should NOT have issued any warmups yet on the workers we didn't ack.
    expect(resolved).toBe(false);

    // Ack the last worker's loadDone — now engine issues warmup to every worker.
    await ackLoadOn(createdWorkers.at(-1)!);

    // Ack warmupDone on all but the last worker.
    for (let index = 0; index < createdWorkers.length - 1; index++) {
      await ackWarmupOn(createdWorkers[index]!);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);
    expect(service.isLoaded()).toBe(false);

    // Final warmupDone — now load() resolves.
    await ackWarmupOn(createdWorkers.at(-1)!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(true);
    expect(service.isLoaded()).toBe(true);
  });

  it('load() forwards loadProgress events from slot 0 only (other slots read from cache)', async () => {
    const onProgress = vi.fn();
    const service = getTtsService();
    const loadPromise = service.load('af_heart', onProgress);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const slot0Load = lastInboundOfType(createdWorkers[0]!, 'load')!;
    createdWorkers[0]!.send({
      type: 'loadProgress',
      requestId: slot0Load.requestId,
      loaded: 50,
      total: 100,
    });
    expect(onProgress).toHaveBeenCalledWith(50, 100);
    onProgress.mockClear();

    // Progress from other slots is suppressed — they hit the IndexedDB cache.
    for (let index = 1; index < createdWorkers.length; index++) {
      const lm = lastInboundOfType(createdWorkers[index]!, 'load')!;
      createdWorkers[index]!.send({
        type: 'loadProgress',
        requestId: lm.requestId,
        loaded: 25,
        total: 100,
      });
    }
    expect(onProgress).not.toHaveBeenCalled();

    await completeLoad();
    await loadPromise;
  });

  it('load() rejects fail-fast on the first loadError from any worker', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const slot1Load = lastInboundOfType(createdWorkers[1] ?? createdWorkers[0]!, 'load')!;
    (createdWorkers[1] ?? createdWorkers[0]!).send({
      type: 'loadError',
      requestId: slot1Load.requestId,
      message: 'gpu died',
    });
    await expect(loadPromise).rejects.toThrow('gpu died');
    expect(service.isLoaded()).toBe(false);
  });

  it('load() concurrent calls share the same in-flight promise (still one pool spawned)', async () => {
    const service = getTtsService();
    const promiseA = service.load('af_heart');
    const promiseB = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createdWorkers).toHaveLength(WORKER_POOL_SIZE);
    for (const worker of createdWorkers) {
      expect(countInboundOfType(worker, 'load')).toBe(1);
    }
    await completeLoad();
    await Promise.all([promiseA, promiseB]);
  });

  it('load() is idempotent — calling twice after success does not spawn another pool', async () => {
    const service = getTtsService();
    const p1 = service.load('af_heart');
    await completeLoad();
    await p1;
    await service.load('af_heart');
    expect(createdWorkers).toHaveLength(WORKER_POOL_SIZE);
  });

  it('warmupError on all workers still resolves load() successfully (best-effort)', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const worker of createdWorkers) await ackLoadOn(worker);
    for (const worker of createdWorkers) {
      const wm = lastInboundOfType(worker, 'warmup')!;
      worker.send({ type: 'warmupError', requestId: wm.requestId, message: 'oom' });
      worker.send({ type: 'workerReady' });
    }
    await expect(loadPromise).resolves.toBeUndefined();
    expect(service.isLoaded()).toBe(true);
  });

  it('ignores a loadDone with a requestId that does not match any in-flight load', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    let resolved = false;
    /* eslint-disable promise/prefer-await-to-then, promise/always-return -- observe resolution without awaiting */
    loadPromise
      .then(() => {
        resolved = true;
      })
      .catch(() => {});
    /* eslint-enable promise/prefer-await-to-then, promise/always-return */
    await new Promise((resolve) => setTimeout(resolve, 0));
    createdWorkers[0]!.send({ type: 'loadDone', requestId: 'stale-id' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);
    expect(service.isLoaded()).toBe(false);

    await completeLoad();
    await loadPromise;
    expect(service.isLoaded()).toBe(true);
  });

  it('ignores a loadError with a stale requestId', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    createdWorkers[0]!.send({
      type: 'loadError',
      requestId: 'stale-id',
      message: 'should be ignored',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await completeLoad();
    await loadPromise;
    expect(service.isLoaded()).toBe(true);
  });

  it('ignores a warmupDone with a stale requestId', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const worker of createdWorkers) await ackLoadOn(worker);
    // Send a stale warmupDone — should be ignored, load still pending.
    createdWorkers[0]!.send({ type: 'warmupDone', requestId: 'stale-warmup-id' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.isLoaded()).toBe(false);
    for (const worker of createdWorkers) await ackWarmupOn(worker);
    await loadPromise;
    expect(service.isLoaded()).toBe(true);
  });

  it('unlockAudio() creates an AudioContext and primes it with a 1-sample buffer', () => {
    const service = getTtsService();
    service.unlockAudio();
    expect(createdContexts).toHaveLength(1);
    const ctx = createdContexts[0]!;
    expect(ctx.createBuffer).toHaveBeenCalledWith(1, 1, expect.any(Number));
    expect(createdSources).toHaveLength(1);
    const source = createdSources[0]!;
    expect(source.connect).toHaveBeenCalledWith(ctx.destination);
    expect(source.start).toHaveBeenCalled();
  });

  it('unlockAudio() is idempotent — re-calling does not create a new AudioContext', () => {
    const service = getTtsService();
    service.unlockAudio();
    service.unlockAudio();
    expect(createdContexts).toHaveLength(1);
  });

  it('speak() throws when called before load()', async () => {
    const service = getTtsService();
    await expect(service.speak('hello', 'af_heart')).rejects.toThrow(/not loaded/i);
  });

  it('speak() dispatches to slot 0 (first idle) when the whole pool is idle', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    void service.speak('hello world', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countInboundOfType(createdWorkers[0]!, 'speak')).toBe(1);
    for (let index = 1; index < createdWorkers.length; index++) {
      expect(countInboundOfType(createdWorkers[index]!, 'speak')).toBe(0);
    }
    const msg = lastInboundOfType(createdWorkers[0]!, 'speak')!;
    expect(msg.text).toBe('hello world');
    expect(msg.voice).toBe('af_heart');
  });

  it('speak() plays the audio buffer returned by the worker and resolves on ended', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    service.unlockAudio();
    const speakPromise = service.speak('hi', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const speakMsg = lastInboundOfType(createdWorkers[0]!, 'speak')!;
    const audio = new Float32Array(100);
    createdWorkers[0]!.send({
      type: 'speakReady',
      requestId: speakMsg.requestId,
      audio,
      samplingRate: 24_000,
    });
    createdWorkers[0]!.send({ type: 'workerReady' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ctx = createdContexts[0]!;
    expect(ctx.createBuffer).toHaveBeenLastCalledWith(1, 100, 24_000);
    const source = createdSources.at(-1)!;
    expect(source.connect).toHaveBeenCalledWith(ctx.destination);
    expect(source.start).toHaveBeenCalled();
    source.triggerEnded();
    await expect(speakPromise).resolves.toBeUndefined();
  });

  it('speak() rejects on speakError', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const speakPromise = service.speak('boom', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const speakMsg = lastInboundOfType(createdWorkers[0]!, 'speak')!;
    createdWorkers[0]!.send({
      type: 'speakError',
      requestId: speakMsg.requestId,
      message: 'generation failed',
    });
    await expect(speakPromise).rejects.toThrow('generation failed');
  });

  it('speak() fan-out: three concurrent speaks land one per slot when the pool is idle', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    void service.speak('a', 'af_heart');
    void service.speak('b', 'af_heart');
    void service.speak('c', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(WORKER_POOL_SIZE).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < 3; index++) {
      expect(countInboundOfType(createdWorkers[index]!, 'speak')).toBe(1);
    }
  });

  it('speak() called N+1 times with N idle slots queues the (N+1)th until a workerReady arrives', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;

    // Fire N+1 speaks where N is the pool size.
    const N = WORKER_POOL_SIZE;
    for (let index = 0; index < N + 1; index++) {
      void service.speak(`s${String(index)}`, 'af_heart');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Exactly one speak per slot — the (N+1)th waits.
    const dispatched = createdWorkers.reduce((sum, w) => sum + countInboundOfType(w, 'speak'), 0);
    expect(dispatched).toBe(N);

    // Slot 0 finishes. The queued speak should now be dispatched to slot 0.
    ackSpeakOn(createdWorkers[0]!, 10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countInboundOfType(createdWorkers[0]!, 'speak')).toBe(2);
    const totalNow = createdWorkers.reduce((sum, w) => sum + countInboundOfType(w, 'speak'), 0);
    expect(totalNow).toBe(N + 1);
  });

  it('dispatch resumes for queued speaks as each workerReady arrives', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;

    // Saturate the pool, then queue 2 extra.
    for (let index = 0; index < WORKER_POOL_SIZE + 2; index++) {
      void service.speak(`q${String(index)}`, 'af_heart');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const initialTotal = createdWorkers.reduce((sum, w) => sum + countInboundOfType(w, 'speak'), 0);
    expect(initialTotal).toBe(WORKER_POOL_SIZE);

    ackSpeakOn(createdWorkers[0]!, 10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let total = createdWorkers.reduce((sum, w) => sum + countInboundOfType(w, 'speak'), 0);
    expect(total).toBe(WORKER_POOL_SIZE + 1);

    ackSpeakOn(createdWorkers[1]!, 10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    total = createdWorkers.reduce((sum, w) => sum + countInboundOfType(w, 'speak'), 0);
    expect(total).toBe(WORKER_POOL_SIZE + 2);
  });

  it('two speak() calls in a row both post messages BEFORE either plays (pipelining)', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    void service.speak('first', 'af_heart');
    void service.speak('second', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastInboundOfType(createdWorkers[0]!, 'speak')!.text).toBe('first');
    expect(lastInboundOfType(createdWorkers[1]!, 'speak')!.text).toBe('second');
    expect(createdSources.filter((s) => s.start.mock.calls.length > 0)).toHaveLength(0);
  });

  it('audio for a LATER speak arriving first still plays the EARLIER sentence first (pool out-of-order)', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    service.unlockAudio();
    const sourcesBefore = createdSources.length;

    const p0 = service.speak('first', 'af_heart');
    const p1 = service.speak('second', 'af_heart');
    const p2 = service.speak('third', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Audio arrives in reverse slot order: slot 2 finishes first, then 1, then 0.
    const id2 = lastInboundOfType(createdWorkers[2]!, 'speak')!.requestId;
    const id1 = lastInboundOfType(createdWorkers[1]!, 'speak')!.requestId;
    const id0 = lastInboundOfType(createdWorkers[0]!, 'speak')!.requestId;
    createdWorkers[2]!.send({
      type: 'speakReady',
      requestId: id2,
      audio: new Float32Array(30),
      samplingRate: 24_000,
    });
    createdWorkers[1]!.send({
      type: 'speakReady',
      requestId: id1,
      audio: new Float32Array(20),
      samplingRate: 24_000,
    });
    createdWorkers[0]!.send({
      type: 'speakReady',
      requestId: id0,
      audio: new Float32Array(10),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const speakSources = createdSources.slice(sourcesBefore);
    expect(speakSources.length).toBe(3);
    // Playback chain serializes scheduling in original speak() call order.
    expect(speakSources[0]!.buffer?.length).toBe(10);
    expect(speakSources[1]!.buffer?.length).toBe(20);
    expect(speakSources[2]!.buffer?.length).toBe(30);
    const start0 = (speakSources[0]!.start.mock.calls[0] as [number])[0];
    const start1 = (speakSources[1]!.start.mock.calls[0] as [number])[0];
    const start2 = (speakSources[2]!.start.mock.calls[0] as [number])[0];
    expect(start1).toBeGreaterThanOrEqual(start0);
    expect(start2).toBeGreaterThanOrEqual(start1);
    speakSources[0]!.triggerEnded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await p0;
    speakSources[1]!.triggerEnded();
    await p1;
    speakSources[2]!.triggerEnded();
    await p2;
  });

  it('stop() stops the currently playing source', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const speakPromise = service.speak('to stop', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const speakMsg = lastInboundOfType(createdWorkers[0]!, 'speak')!;
    createdWorkers[0]!.send({
      type: 'speakReady',
      requestId: speakMsg.requestId,
      audio: new Float32Array(100),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const source = createdSources.at(-1)!;
    service.stop();
    expect(source.stop).toHaveBeenCalled();
    source.triggerEnded();
    await speakPromise;
  });

  it('stop() posts a cancel to every busy worker for its in-flight requestId', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;

    // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget so cancel can happen during inference
    service.speak('a', 'af_heart').catch(() => {});
    // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget
    service.speak('b', 'af_heart').catch(() => {});
    // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget
    service.speak('c', 'af_heart').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ids = [
      lastInboundOfType(createdWorkers[0]!, 'speak')!.requestId,
      lastInboundOfType(createdWorkers[1]!, 'speak')!.requestId,
      lastInboundOfType(createdWorkers[2]!, 'speak')!.requestId,
    ];

    service.stop();

    for (let index = 0; index < 3; index++) {
      expect(countInboundOfType(createdWorkers[index]!, 'cancel')).toBe(1);
      expect(lastInboundOfType(createdWorkers[index]!, 'cancel')!.requestId).toBe(ids[index]);
    }
  });

  it('stop() before any speak() is a safe no-op', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    expect(() => {
      service.stop();
    }).not.toThrow();
  });

  it('stop() rejects a pending speak() promise with a cancellation error', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const pending = service.speak('still generating', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.stop();
    await expect(pending).rejects.toThrow(/cancell?ed/i);
  });

  it('stop() drains the queue: queued speaks are rejected and never dispatched even after a workerReady', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;

    // Saturate the pool and queue an extra speak.
    for (let index = 0; index < WORKER_POOL_SIZE; index++) {
      // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget
      service.speak(`busy${String(index)}`, 'af_heart').catch(() => {});
    }
    const queued = service.speak('queued', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const totalBefore = createdWorkers.reduce((sum, w) => sum + countInboundOfType(w, 'speak'), 0);
    expect(totalBefore).toBe(WORKER_POOL_SIZE);

    service.stop();
    await expect(queued).rejects.toThrow(/cancell?ed/i);

    // Workers eventually emit workerReady for the cancelled speaks. The
    // queued speak must NOT be re-dispatched.
    for (const worker of createdWorkers) worker.send({ type: 'workerReady' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const totalAfter = createdWorkers.reduce((sum, w) => sum + countInboundOfType(w, 'speak'), 0);
    expect(totalAfter).toBe(WORKER_POOL_SIZE);
  });

  it('stop() suppresses a speak whose audio was resolved in the same tick as the click', async () => {
    // Race: a worker posts speakReady (synchronously runs onSpeakReady → resolves
    // the audioPromise) in the same tick the user clicks Stop. The cancel path
    // misses it (onSpeakReady already cleared its tracking entries) and the
    // source isn't yet scheduled. Without the epoch guard, the awaiting speak()
    // chain wakes up post-stop and calls source.start(), leaking audio.
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;

    const pending = service.speak('leaked audio', 'af_heart');
    // Surface unhandled rejection if cancel propagates as an error.
    // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    const speakMsg = lastInboundOfType(createdWorkers[0]!, 'speak')!;
    const sourcesBefore = createdSources.length;
    // Synchronous in this tick: dispatchEvent runs onSpeakReady inline, which
    // resolves audioPromise — but the speak() chain's await wakes up on a
    // microtask, not synchronously.
    createdWorkers[0]!.send({
      type: 'speakReady',
      requestId: speakMsg.requestId,
      audio: new Float32Array(100),
      samplingRate: 24_000,
    });
    service.stop();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const newSources = createdSources.slice(sourcesBefore);
    for (const source of newSources) {
      expect(source.start).not.toHaveBeenCalled();
    }
  });

  it('load() sends the supplied voice in the warmup message to every worker', async () => {
    const service = getTtsService();
    const loadPromise = service.load('am_michael');
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const worker of createdWorkers) await ackLoadOn(worker);
    for (const worker of createdWorkers) {
      const warmupMsg = lastInboundOfType(worker, 'warmup')!;
      expect(warmupMsg.voice).toBe('am_michael');
      worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
      worker.send({ type: 'workerReady' });
    }
    await loadPromise;
  });

  it('preloadVoice() fan-outs a warmup with the new voice to every worker and resolves when all settle', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const beforeCounts = createdWorkers.map((w) => countInboundOfType(w, 'warmup'));
    const preload = service.preloadVoice('bm_george');
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [index, createdWorker] of createdWorkers.entries()) {
      expect(countInboundOfType(createdWorker, 'warmup')).toBe(beforeCounts[index]! + 1);
      const last = lastInboundOfType(createdWorker, 'warmup')!;
      expect(last.voice).toBe('bm_george');
      createdWorker.send({ type: 'warmupDone', requestId: last.requestId });
      createdWorker.send({ type: 'workerReady' });
    }
    await expect(preload).resolves.toBeUndefined();
  });

  it('preloadVoice() rejects when called before load() resolves', async () => {
    const service = getTtsService();
    await expect(service.preloadVoice('bm_george')).rejects.toThrow(/not loaded/i);
  });

  it('preloadVoice() rejects when any worker reports warmupError', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const preload = service.preloadVoice('bm_george');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Slot 0 reports an error; the other slots succeed.
    const slot0Warmup = lastInboundOfType(createdWorkers[0]!, 'warmup')!;
    createdWorkers[0]!.send({
      type: 'warmupError',
      requestId: slot0Warmup.requestId,
      message: 'voice fetch failed',
    });
    createdWorkers[0]!.send({ type: 'workerReady' });
    for (let index = 1; index < createdWorkers.length; index++) {
      const warmupMsg = lastInboundOfType(createdWorkers[index]!, 'warmup')!;
      createdWorkers[index]!.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
      createdWorkers[index]!.send({ type: 'workerReady' });
    }
    await expect(preload).rejects.toThrow('voice fetch failed');
  });

  it('schedules consecutive sentences sample-accurately even when audio comes from different workers', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    service.unlockAudio();
    const ctx = createdContexts[0]!;
    ctx.currentTime = 5;
    const sourcesBefore = createdSources.length;

    const firstPromise = service.speak('first', 'af_heart');
    const secondPromise = service.speak('second', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstId = lastInboundOfType(createdWorkers[0]!, 'speak')!.requestId;
    const secondId = lastInboundOfType(createdWorkers[1]!, 'speak')!.requestId;
    createdWorkers[0]!.send({
      type: 'speakReady',
      requestId: firstId,
      audio: new Float32Array(2400),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    createdWorkers[1]!.send({
      type: 'speakReady',
      requestId: secondId,
      audio: new Float32Array(4800),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const speakSources = createdSources.slice(sourcesBefore);
    expect(speakSources.length).toBe(2);
    const firstStart = (speakSources[0]!.start.mock.calls[0] as [number])[0];
    const secondStart = (speakSources[1]!.start.mock.calls[0] as [number])[0];
    expect(firstStart).toBeCloseTo(5, 5);
    expect(secondStart).toBeCloseTo(5.1, 5);

    speakSources[0]!.triggerEnded();
    speakSources[1]!.triggerEnded();
    await firstPromise;
    await secondPromise;
  });

  it('schedules immediately when nextStartTime lags behind currentTime (inference slower than playback)', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    service.unlockAudio();
    const ctx = createdContexts[0]!;
    ctx.currentTime = 10;

    const firstPromise = service.speak('first', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstSpeakMsg = lastInboundOfType(createdWorkers[0]!, 'speak')!;
    createdWorkers[0]!.send({
      type: 'speakReady',
      requestId: firstSpeakMsg.requestId,
      audio: new Float32Array(2400),
      samplingRate: 24_000,
    });
    createdWorkers[0]!.send({ type: 'workerReady' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    createdSources.at(-1)!.triggerEnded();
    await firstPromise;

    ctx.currentTime = 30;
    const secondPromise = service.speak('second', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // After workerReady, slot 0 is idle again, so second speak goes to slot 0.
    const secondSpeakMsg = lastInboundOfType(createdWorkers[0]!, 'speak')!;
    createdWorkers[0]!.send({
      type: 'speakReady',
      requestId: secondSpeakMsg.requestId,
      audio: new Float32Array(2400),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startedSources = createdSources.filter((s) => s.start.mock.calls.length > 0);
    const secondStart = (startedSources.at(-1)!.start.mock.calls[0] as [number])[0];
    expect(secondStart).toBeCloseTo(30, 5);
    createdSources.at(-1)!.triggerEnded();
    await secondPromise;
  });

  it('stop() stops every scheduled source across the pool, not just the first one', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    service.unlockAudio();
    const ctx = createdContexts[0]!;
    ctx.currentTime = 0;
    const sourcesBefore = createdSources.length;

    const firstPromise = service.speak('first', 'af_heart');
    const secondPromise = service.speak('second', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const id0 = lastInboundOfType(createdWorkers[0]!, 'speak')!.requestId;
    const id1 = lastInboundOfType(createdWorkers[1]!, 'speak')!.requestId;
    createdWorkers[0]!.send({
      type: 'speakReady',
      requestId: id0,
      audio: new Float32Array(24_000),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    createdWorkers[1]!.send({
      type: 'speakReady',
      requestId: id1,
      audio: new Float32Array(24_000),
      samplingRate: 24_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const speakSources = createdSources.slice(sourcesBefore);
    expect(speakSources.length).toBe(2);

    service.stop();
    for (const source of speakSources) {
      expect(source.stop).toHaveBeenCalled();
    }
    for (const source of speakSources) source.triggerEnded();
    await firstPromise;
    await secondPromise;
  });

  it('speak() forwards each voice in TTS_VOICES correctly', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;
    const voices: TtsVoice[] = ['af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_nicole'];
    for (const voice of voices) {
      const promise = service.speak(`x ${voice}`, voice);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Slot 0 is idle each iteration (we ack between iterations), so each
      // speak lands there.
      const speakMsg = lastInboundOfType(createdWorkers[0]!, 'speak')!;
      expect(speakMsg.voice).toBe(voice);
      createdWorkers[0]!.send({
        type: 'speakReady',
        requestId: speakMsg.requestId,
        audio: new Float32Array(10),
        samplingRate: 24_000,
      });
      createdWorkers[0]!.send({ type: 'workerReady' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const source = createdSources.at(-1)!;
      source.triggerEnded();
      await promise;
    }
  });

  it('_resetTtsServiceForTesting terminates every worker in the pool', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await completeLoad();
    await loadPromise;
    const workersAtReset = [...createdWorkers];
    _resetTtsServiceForTesting();
    for (const worker of workersAtReset) {
      expect(worker.terminate).toHaveBeenCalled();
    }
  });

  it('load() rejects when a worker emits an error event before loadDone', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    createdWorkers[1]!.crash('worker died during load');
    await expect(loadPromise).rejects.toThrow('worker died during load');
    expect(service.isLoaded()).toBe(false);
  });

  it('load() rejects when a worker emits a messageerror event before loadDone', async () => {
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    createdWorkers[0]!.sendMessageError();
    await expect(loadPromise).rejects.toThrow();
    expect(service.isLoaded()).toBe(false);
  });

  it('load() rejects when no worker responds before the load timeout elapses', async () => {
    _setLoadTimeoutMsForTesting(20);
    const service = getTtsService();
    const loadPromise = service.load('af_heart');
    await expect(loadPromise).rejects.toThrow(/timed out|timeout/i);
    expect(service.isLoaded()).toBe(false);
    _setLoadTimeoutMsForTesting(null);
  });

  it('a worker error rejects its in-flight speak and the pool recovers for new work', async () => {
    const service = getTtsService();
    const loadPromise_ = service.load('af_heart');
    await completeLoad();
    await loadPromise_;

    const crashedWorker = createdWorkers[0]!;
    const speakPromise = service.speak('on crashing worker', 'af_heart');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countInboundOfType(crashedWorker, 'speak')).toBe(1);

    crashedWorker.crash('inference worker exploded');
    await expect(speakPromise).rejects.toThrow(/exploded|crash|fail/i);

    // The pool must accept new work. A respawned slot 0 is fresh; the new
    // speak should be dispatchable across the recovered pool.
    const workerCountBefore = createdWorkers.length;
    const recovered = service.speak('after crash', 'af_heart');
    // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget
    recovered.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dispatched = createdWorkers.reduce((sum, w) => sum + countInboundOfType(w, 'speak'), 0);
    // Original speak (1) + the new speak (1) dispatched somewhere in the pool.
    expect(dispatched).toBe(2);
    expect(createdWorkers.length).toBeGreaterThanOrEqual(workerCountBefore);
  });

  describe('stale, unknown, and malformed worker messages', () => {
    it('ignores worker messages that are not valid outbound envelopes', async () => {
      const service = getTtsService();
      // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget load
      void service.load('af_heart').catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(() =>
        createdWorkers[0]!.dispatchEvent(new MessageEvent('message', { data: { type: 'nope' } }))
      ).not.toThrow();
    });

    it('treats a non-ErrorEvent worker error as a generic crash that rejects the load', async () => {
      const service = getTtsService();
      const rejected = expect(service.load('af_heart')).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      createdWorkers[0]!.dispatchEvent(new Event('error'));
      await rejected;
    });

    it('ignores stale load-lifecycle messages after the load has settled', async () => {
      const service = getTtsService();
      const load = service.load('af_heart');
      await completeLoad();
      await load;
      const worker = createdWorkers[0]!;
      expect(() => {
        worker.send({ type: 'loadProgress', requestId: 'stale', loaded: 1, total: 2 });
        worker.send({ type: 'loadDone', requestId: 'stale' });
        worker.send({ type: 'loadError', requestId: 'stale', message: 'late' });
        worker.send({ type: 'warmupDone', requestId: 'stale' });
        worker.send({ type: 'warmupError', requestId: 'stale', message: 'late' });
      }).not.toThrow();
    });

    it('ignores speak results for an unknown request id', async () => {
      const service = getTtsService();
      const load = service.load('af_heart');
      await completeLoad();
      await load;
      const worker = createdWorkers[0]!;
      expect(() => {
        worker.send({
          type: 'speakReady',
          requestId: 'ghost',
          audio: new Float32Array(4),
          samplingRate: 24_000,
        });
        worker.send({ type: 'speakError', requestId: 'ghost', message: 'ghost' });
      }).not.toThrow();
    });

    it('handles a workerReady when the slot has no work in flight', async () => {
      const service = getTtsService();
      const load = service.load('af_heart');
      await completeLoad();
      await load;
      expect(() => {
        createdWorkers[0]!.send({ type: 'workerReady' });
      }).not.toThrow();
    });

    it('ignores load-lifecycle messages whose request id does not match the active load', async () => {
      const service = getTtsService();
      const load = service.load('af_heart');
      await new Promise((resolve) => setTimeout(resolve, 0));
      const worker = createdWorkers[0]!;
      worker.send({ type: 'loadProgress', requestId: 'mismatch', loaded: 1, total: 2 });
      worker.send({ type: 'loadError', requestId: 'mismatch', message: 'ignored' });
      worker.send({ type: 'loadDone', requestId: 'mismatch' });
      worker.send({ type: 'warmupError', requestId: 'mismatch', message: 'ignored' });
      worker.send({ type: 'warmupDone', requestId: 'mismatch' });
      await completeLoad();
      await expect(load).resolves.toBeUndefined();
    });

    it('ignores duplicate loadDone and warmupDone messages for the same slot', async () => {
      const service = getTtsService();
      const load = service.load('af_heart');
      await new Promise((resolve) => setTimeout(resolve, 0));
      const worker = createdWorkers[0]!;
      const loadMsg = lastInboundOfType(worker, 'load')!;
      // A duplicate loadDone for the same slot must be a no-op.
      worker.send({ type: 'loadDone', requestId: loadMsg.requestId });
      worker.send({ type: 'loadDone', requestId: loadMsg.requestId });
      const warmupMsg = lastInboundOfType(worker, 'warmup')!;
      // Duplicate warmupDone for the same slot must be a no-op too.
      worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
      worker.send({ type: 'warmupDone', requestId: warmupMsg.requestId });
      worker.send({ type: 'workerReady' });
      // Finish the remaining slots so the load resolves.
      for (let index = 1; index < createdWorkers.length; index++) {
        await ackLoadOn(createdWorkers[index]!);
      }
      for (let index = 1; index < createdWorkers.length; index++) {
        await ackWarmupOn(createdWorkers[index]!);
      }
      await expect(load).resolves.toBeUndefined();
    });

    it('replacing a crashed slot means a repeat error on the old worker is ignored', async () => {
      const service = getTtsService();
      const rejected = expect(service.load('af_heart')).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const original = createdWorkers[0]!;
      original.crash('first'); // rejects the load and replaces slot 0
      await rejected;
      // The old worker fires a second error; its slot is already replaced.
      expect(() => {
        original.crash('second');
      }).not.toThrow();
    });

    it('reuses the existing worker pool on a load that follows a crash', async () => {
      const service = getTtsService();
      const rejected = expect(service.load('af_heart')).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      createdWorkers[0]!.crash('boom');
      await rejected;
      const poolSize = createdWorkers.length;
      // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget retry
      service.load('af_heart').catch(() => {});
      // The pool already exists, so no fresh workers are spawned synchronously.
      expect(createdWorkers.length).toBe(poolSize);
    });

    it('only rejects the in-flight speaks belonging to the crashed slot', async () => {
      const service = getTtsService();
      const load = service.load('af_heart');
      await completeLoad();
      await load;
      const firstRejected = expect(service.speak('one', 'af_heart')).rejects.toThrow();
      // A second speak on a different slot must not be rejected by the crash.
      // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget speak
      service.speak('two', 'af_heart').catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      const busy = createdWorkers.filter((w) => countInboundOfType(w, 'speak') > 0);
      expect(busy.length).toBeGreaterThanOrEqual(2);
      // Crash the slot holding the first speak; rejectSpeaksForSlot walks every
      // entry and skips the one mapped to the surviving slot.
      busy[0]!.crash('slot down');
      await firstRejected;
    });

    it('falls back to a counter-based request id when crypto.randomUUID is unavailable', async () => {
      const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      try {
        const service = getTtsService();
        // eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget load
        void service.load('af_heart').catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 0));
        const loadMsg = lastInboundOfType(createdWorkers[0]!, 'load');
        expect(loadMsg?.requestId).toMatch(/^req-/);
      } finally {
        if (original) Object.defineProperty(globalThis, 'crypto', original);
      }
    });
  });
});
