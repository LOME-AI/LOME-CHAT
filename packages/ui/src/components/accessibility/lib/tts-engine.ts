// Kokoro TTS engine proxy. Spawns a pool of dedicated Web Workers on first
// use so multiple sentences inference in parallel without blocking the main
// thread. Each worker hosts its own kokoro-js KokoroTTS instance running on
// WASM with q8 weights; this module owns AudioContext playback, the
// playback queue, and the per-slot dispatch scheduler.
//
// Generation and playback are pipelined: speak() enqueues a sentence in
// the pool, the engine round-robins idle slots, and a separate
// `playbackChain` plays audio buffers back in the original speak() call
// order — so audio from slot N+1 finishing before slot N still queues
// correctly behind sentence N's playback.

import { isWorkerOutbound } from './tts-worker-protocol';
import type { WorkerInbound, WorkerOutbound } from './tts-worker-protocol';

/**
 * Number of worker threads in the inference pool. Increase to fan out more
 * concurrent sentence inference at the cost of ~80 MB of resident memory
 * per added worker (q8 model weights duplicate per worker). Decrease for
 * memory-constrained targets (mobile Safari has a tight per-tab budget).
 */
export const WORKER_POOL_SIZE = 4;

export type TtsVoice = 'af_heart' | 'am_michael' | 'bf_emma' | 'bm_george' | 'af_nicole';

export interface TtsVoiceMeta {
  readonly id: TtsVoice;
  readonly displayName: string;
  readonly accent: 'American' | 'British';
  readonly gender: 'female' | 'male';
}

export const TTS_VOICES: readonly TtsVoiceMeta[] = [
  { id: 'af_heart', displayName: 'Heart', accent: 'American', gender: 'female' },
  { id: 'am_michael', displayName: 'Michael', accent: 'American', gender: 'male' },
  { id: 'bf_emma', displayName: 'Emma', accent: 'British', gender: 'female' },
  { id: 'bm_george', displayName: 'George', accent: 'British', gender: 'male' },
  { id: 'af_nicole', displayName: 'Nicole', accent: 'American', gender: 'female' },
];

export interface TtsService {
  /**
   * Lazy-load the model into every worker in the pool. Resolves when every
   * worker has finished loadDone + warmupDone for the supplied voice.
   * Idempotent and safe to call concurrently.
   */
  load(voice: TtsVoice, onProgress?: (loaded: number, total: number) => void): Promise<void>;
  /** True after load() resolved successfully. */
  isLoaded(): boolean;
  /**
   * Re-warm every worker with a different voice so its embedding is fetched
   * up front. Call after the user changes voices. Rejects if the model is
   * not loaded, or if any worker reports a warmupError.
   */
  preloadVoice(voice: TtsVoice): Promise<void>;
  /** Enqueue a sentence. Resolves when audio finishes (or is stopped). Concurrent speak() calls are pipelined across the pool. */
  speak(text: string, voice: TtsVoice): Promise<void>;
  /** Stop any in-flight audio and clear the pipeline. */
  stop(): void;
  /**
   * Required: must be called inside a user gesture (click) on iOS to unlock
   * the AudioContext. Subsequent calls are no-ops.
   *
   * `existing` adopts a context the caller already created, for callers that
   * cannot reach this method synchronously inside the gesture (an `await`
   * before the call drops WebKit's user-activation token, and iOS unlock is
   * per-AudioContext-instance, so only the context that will play can be
   * unlocked). The adopted context is the one playback then uses.
   */
  unlockAudio(existing?: AudioContext): void;
}

let fallbackCounter = 0;
function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackCounter += 1;
  return `req-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

type WorkerFactory = () => Worker;

let workerFactoryOverride: WorkerFactory | null = null;

/** Test-only: override the factory used by new WorkerKokoroTtsService instances. */
export function _setWorkerFactoryForTesting(factory: WorkerFactory | null): void {
  workerFactoryOverride = factory;
}

/**
 * Ceiling for how long load() waits for the whole pool to finish loadDone +
 * warmupDone before failing fast. A worker that hangs (network stall, WASM
 * compile wedge) must surface an error rather than leave load() pending
 * forever and the pool permanently busy.
 */
export const DEFAULT_LOAD_TIMEOUT_MS = 120_000;

let loadTimeoutMsOverride: number | null = null;

/** Test-only: shorten (or restore with null) the load() timeout. */
export function _setLoadTimeoutMsForTesting(ms: number | null): void {
  loadTimeoutMsOverride = ms;
}

/* v8 ignore start */
// Constructs a real module Worker, which cannot load under jsdom; tests always
// inject a fake factory via _setWorkerFactoryForTesting.
function defaultWorkerFactory(): Worker {
  // Vite bundles workers referenced via `new URL(..., import.meta.url)` as
  // a separate chunk. `type: 'module'` matches the worker's ES module
  // source — Vite's default `iife` format would break the static
  // kokoro-js import at the top of tts.worker.ts.
  return new Worker(new URL('tts.worker.ts', import.meta.url), { type: 'module' });
}
/* v8 ignore stop */

/** Thrown when stop() cancels a pending speak() before audio finishes. */
class CancelledError extends Error {
  constructor() {
    super('TTS speak was cancelled');
    this.name = 'CancelledError';
  }
}

/** Thrown to a slot's outstanding load/speak when its worker crashes. */
class WorkerCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerCrashError';
  }
}

/** Thrown when load() does not complete before the load timeout elapses. */
class LoadTimeoutError extends Error {
  constructor() {
    super('TTS model load timed out');
    this.name = 'LoadTimeoutError';
  }
}

interface WorkerSlot {
  worker: Worker;
  /**
   * Count of outstanding workerReady messages this slot is expected to
   * emit. 0 means the slot is idle and eligible for the next queued speak.
   * Incremented when the engine posts a speak/warmup (either of which
   * produces a workerReady); decremented when workerReady arrives.
   */
  inflight: number;
}

interface PendingLoad {
  resolve: () => void;
  reject: (error: Error) => void;
  onProgress: ((loaded: number, total: number) => void) | undefined;
  voice: TtsVoice;
  loadRequestIdBySlot: string[];
  warmupRequestIdBySlot: (string | null)[];
  loadDoneBySlot: boolean[];
  warmupSettledBySlot: boolean[];
}

interface PendingWarmup {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingSpeak {
  resolveAudio: (data: { audio: Float32Array; samplingRate: number }) => void;
  rejectAudio: (error: Error) => void;
}

interface QueuedSpeak {
  requestId: string;
  text: string;
  voice: TtsVoice;
}

class WorkerKokoroTtsService implements TtsService {
  private workers: WorkerSlot[] = [];
  private loaded = false;
  private pendingLoad: PendingLoad | null = null;
  private loadPromise: Promise<void> | null = null;
  /** Fail-fast timer for the in-flight load(); cleared the moment it settles. */
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * One entry per in-flight preloadVoice warmup (separate from load-lifecycle
   * warmups which live on `pendingLoad.warmupRequestIdBySlot`). Keyed by the
   * individual per-slot warmup requestId — preloadVoice fans out N entries
   * and Promise.all aggregates them.
   */
  private pendingPreloads = new Map<string, PendingWarmup>();
  private pendingSpeaks = new Map<string, PendingSpeak>();
  /** requestId → slotIndex so stop() can route cancel to the right worker. */
  private speakSlotByRequestId = new Map<string, number>();
  /** FIFO queue of sentences waiting for an idle slot. */
  private pendingQueue: QueuedSpeak[] = [];
  private audioCtx: AudioContext | null = null;
  // Sample-accurate playback scheduling: nextStartTime tracks the absolute
  // AudioContext time at which the *next* buffer should begin, so back-to-
  // back sentences play with zero gap. scheduledSources holds every buffer
  // that has been `start()`ed but not yet `'ended'`; stop() walks the set
  // so pre-scheduled future buffers are cancelled too.
  private nextStartTime = 0;
  private scheduledSources = new Set<AudioBufferSourceNode>();
  private playbackChain: Promise<void> = Promise.resolve();
  // Bumped on every stop(). Each speak() captures the value at entry and
  // refuses to schedule audio if it changed while waiting for the worker.
  // Closes the race where a worker resolves audio in the same tick as the
  // user clicks Stop: the cancel path can't reach a request that has already
  // had its tracking entries cleared by onSpeakReady but whose chain hasn't
  // yet reached scheduleAudio.
  private stopEpoch = 0;

  constructor(private readonly factory: WorkerFactory = defaultWorkerFactory) {}

  load(voice: TtsVoice, onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loadPromise !== null) return this.loadPromise;

    if (this.workers.length === 0) {
      for (let slotIndex = 0; slotIndex < WORKER_POOL_SIZE; slotIndex++) {
        this.workers.push(this.spawnWorkerForSlot(slotIndex));
      }
    }

    const loadRequestIdBySlot: string[] = [];
    for (let slotIndex = 0; slotIndex < WORKER_POOL_SIZE; slotIndex++) {
      loadRequestIdBySlot.push(newRequestId());
    }

    this.loadPromise = new Promise<void>((resolve, reject) => {
      this.pendingLoad = {
        resolve,
        reject,
        onProgress,
        voice,
        loadRequestIdBySlot,
        warmupRequestIdBySlot: Array.from({ length: WORKER_POOL_SIZE }, (): string | null => null),
        loadDoneBySlot: Array.from({ length: WORKER_POOL_SIZE }, (): boolean => false),
        warmupSettledBySlot: Array.from({ length: WORKER_POOL_SIZE }, (): boolean => false),
      };
    });

    const timeoutMs = loadTimeoutMsOverride ?? DEFAULT_LOAD_TIMEOUT_MS;
    this.loadTimer = setTimeout(() => {
      // Defensive: the timer is always cleared before pendingLoad is nulled
      // (resolveLoad/rejectLoad both clearLoadTimer), so this never fires null.
      /* v8 ignore next */
      if (this.pendingLoad === null) return;
      this.tearDownWorkers();
      this.rejectLoad(new LoadTimeoutError());
    }, timeoutMs);

    // Dedicated download phase: only slot 0 is told to load. Each worker is
    // its own realm with its own cache lookup, and transformers.js writes the
    // Cache API entry only after the whole ~92 MB body is read, so loading the
    // pool in parallel makes every slot miss and fetch the weights again. The
    // fetches cannot coalesce either: the model URL answers with a `no-store`
    // 302 to a per-request signed CDN URL, a different HTTP cache key each
    // time. Slots 1..N are handed `load` in onLoadDone once slot 0 has
    // populated the cache.
    const downloadSlot = this.workers[0];
    const downloadRequestId = loadRequestIdBySlot[0];
    // Defensive: the pool is non-empty and holds one requestId per slot.
    /* v8 ignore next */
    if (downloadSlot !== undefined && downloadRequestId !== undefined) {
      this.postToSlot(downloadSlot, { type: 'load', requestId: downloadRequestId });
    }

    return this.loadPromise;
  }

  /**
   * Hand `load` to every slot except slot 0. Called once slot 0 reports
   * loadDone, at which point the weights are in the Cache API entry every
   * worker shares, so these loads read from cache instead of re-downloading.
   */
  private fanOutLoadAfterDownload(pending: PendingLoad): void {
    for (const [slotIndex, slot] of this.workers.entries()) {
      if (slotIndex === 0) continue;
      const reqId = pending.loadRequestIdBySlot[slotIndex];
      // Defensive: loadRequestIdBySlot has one entry per worker slot, so the
      // parallel index is always defined (noUncheckedIndexedAccess guard).
      /* v8 ignore next */
      if (reqId === undefined) continue;
      this.postToSlot(slot, { type: 'load', requestId: reqId });
    }
  }

  /** Resolve the in-flight load(), mark loaded, and clear the fail-fast timer. */
  private resolveLoad(pending: PendingLoad): void {
    this.clearLoadTimer();
    this.pendingLoad = null;
    this.loaded = true;
    pending.resolve();
  }

  /** Reject the in-flight load() and clear the fail-fast timer and promise. */
  private rejectLoad(error: Error): void {
    const pending = this.pendingLoad;
    if (pending === null) return;
    this.clearLoadTimer();
    this.pendingLoad = null;
    this.loadPromise = null;
    pending.reject(error);
  }

  private clearLoadTimer(): void {
    if (this.loadTimer !== null) {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
    }
  }

  /** Terminate and drop every worker so a failed load leaves no zombie pool. */
  private tearDownWorkers(): void {
    for (const slot of this.workers) slot.worker.terminate();
    this.workers = [];
  }

  preloadVoice(voice: TtsVoice): Promise<void> {
    if (!this.loaded) {
      return Promise.reject(new Error('TTS engine is not loaded — call load() first'));
    }
    const perSlotPromises = this.workers.map((slot) => {
      const requestId = newRequestId();
      return new Promise<void>((resolve, reject) => {
        this.pendingPreloads.set(requestId, { resolve, reject });
        slot.inflight++;
        this.postToSlot(slot, { type: 'warmup', requestId, voice });
      });
    });
    return (async (): Promise<void> => {
      await Promise.all(perSlotPromises);
    })();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  unlockAudio(existing?: AudioContext): void {
    if (this.audioCtx !== null) return;
    const ctx = existing ?? new AudioContext();
    this.audioCtx = ctx;
    const buffer = ctx.createBuffer(1, 1, 22_050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  }

  speak(text: string, voice: TtsVoice): Promise<void> {
    if (!this.loaded) {
      return Promise.reject(new Error('TTS engine is not loaded — call load() first'));
    }
    const startedEpoch = this.stopEpoch;
    const requestId = newRequestId();
    const audioPromise = new Promise<{ audio: Float32Array; samplingRate: number }>(
      (resolve, reject) => {
        this.pendingSpeaks.set(requestId, { resolveAudio: resolve, rejectAudio: reject });
      }
    );
    this.pendingQueue.push({ requestId, text, voice });
    this.dispatchPending();

    // Two-stage chain: `playbackChain` serializes the *scheduling* step (so
    // nextStartTime is computed in original speak() order even when workers
    // finish out of order), and advances as soon as the current sentence's
    // source has been `start()`ed — not after `'ended'`. That lets sentence
    // N+1's source be scheduled at sentence N's end-time while N is still
    // playing, eliminating the inter-buffer gap.
    const previousChain = this.playbackChain;
    let signalScheduled!: () => void;
    const scheduled = new Promise<void>((resolve) => {
      signalScheduled = resolve;
    });
    this.playbackChain = (async (): Promise<void> => {
      try {
        await scheduled;
      } catch {
        // Both success and failure of `scheduled` are acceptable triggers
        // for the next sentence to begin its own scheduling.
      }
    })();
    return (async () => {
      await previousChain;
      let audio: { audio: Float32Array; samplingRate: number };
      try {
        audio = await audioPromise;
      } catch (error: unknown) {
        signalScheduled();
        throw error;
      }
      if (this.stopEpoch !== startedEpoch) {
        signalScheduled();
        throw new CancelledError();
      }
      let scheduleResult: { endedPromise: Promise<void> };
      try {
        scheduleResult = await this.scheduleAudio(audio.audio, audio.samplingRate);
      } catch (error: unknown) {
        signalScheduled();
        throw error;
      }
      signalScheduled();
      await scheduleResult.endedPromise;
    })();
  }

  stop(): void {
    this.stopEpoch++;
    this.playbackChain = Promise.resolve();
    this.rejectQueuedSpeaks();
    this.cancelInflightSpeaks();
    this.stopAllScheduledSources();
    this.nextStartTime = 0;
  }

  private rejectQueuedSpeaks(): void {
    for (const item of this.pendingQueue) {
      const speak = this.pendingSpeaks.get(item.requestId);
      // Defensive: a queued item always has a matching pendingSpeaks entry.
      /* v8 ignore next */
      if (speak === undefined) continue;
      this.pendingSpeaks.delete(item.requestId);
      speak.rejectAudio(new CancelledError());
    }
    this.pendingQueue.length = 0;
  }

  private cancelInflightSpeaks(): void {
    for (const [requestId, slotIndex] of this.speakSlotByRequestId) {
      const slot = this.workers[slotIndex];
      // Defensive: speakSlotByRequestId only ever maps to live slot indices.
      /* v8 ignore next */
      if (slot !== undefined) this.postToSlot(slot, { type: 'cancel', requestId });
      const speak = this.pendingSpeaks.get(requestId);
      // Defensive: an in-flight requestId always has a pendingSpeaks entry.
      /* v8 ignore next */
      if (speak === undefined) continue;
      this.pendingSpeaks.delete(requestId);
      speak.rejectAudio(new CancelledError());
    }
    this.speakSlotByRequestId.clear();
  }

  private stopAllScheduledSources(): void {
    // Multiple sources may be pre-scheduled at once (sample-accurate
    // pipeline). Stop all of them — the second sentence might already be
    // queued to start at a future AudioContext.currentTime.
    for (const source of this.scheduledSources) {
      try {
        source.stop();
      } catch {
        // Already stopped or never started — inert either way.
      }
    }
    this.scheduledSources.clear();
  }

  terminate(): void {
    this.clearLoadTimer();
    for (const slot of this.workers) slot.worker.terminate();
    this.workers = [];
    this.loaded = false;
    this.pendingLoad = null;
    this.loadPromise = null;
    this.pendingPreloads.clear();
    this.pendingSpeaks.clear();
    this.speakSlotByRequestId.clear();
    this.pendingQueue.length = 0;
  }

  private spawnWorkerForSlot(slotIndex: number): WorkerSlot {
    const worker = this.factory();
    const slot: WorkerSlot = { worker, inflight: 0 };
    worker.addEventListener('message', (event: MessageEvent) => {
      const data = (event as MessageEvent<unknown>).data;
      if (!isWorkerOutbound(data)) return;
      this.handleWorkerMessage(slotIndex, slot, data);
    });
    // A worker that throws (uncaught error) or fails to deserialize a message
    // never replies to its load/speak, hanging those promises forever and
    // leaving the slot permanently busy. Surface the failure and respawn.
    worker.addEventListener('error', (event: Event) => {
      const message = event instanceof ErrorEvent ? event.message : 'TTS worker error';
      this.onWorkerError(slotIndex, slot, message);
    });
    worker.addEventListener('messageerror', () => {
      this.onWorkerError(slotIndex, slot, 'TTS worker message deserialization failed');
    });
    return slot;
  }

  private onWorkerError(slotIndex: number, slot: WorkerSlot, message: string): void {
    const error = new WorkerCrashError(message);
    // Fail-fast a load in progress: a partial pool is meaningless.
    this.rejectLoad(error);
    this.rejectSpeaksForSlot(slotIndex, error);
    // Respawn so the pool recovers: the dead worker is replaced by a fresh
    // idle slot eligible for the next queued sentence.
    if (this.workers[slotIndex] === slot) {
      slot.worker.terminate();
      this.workers[slotIndex] = this.spawnWorkerForSlot(slotIndex);
    }
    this.dispatchPending();
  }

  private rejectSpeaksForSlot(slotIndex: number, error: Error): void {
    for (const [requestId, mappedSlot] of this.speakSlotByRequestId) {
      if (mappedSlot !== slotIndex) continue;
      this.speakSlotByRequestId.delete(requestId);
      const speak = this.pendingSpeaks.get(requestId);
      // Defensive: the slot mapping and pendingSpeaks map stay in lockstep.
      /* v8 ignore next */
      if (speak === undefined) continue;
      this.pendingSpeaks.delete(requestId);
      speak.rejectAudio(error);
    }
  }

  private postToSlot(slot: WorkerSlot, msg: WorkerInbound): void {
    slot.worker.postMessage(msg);
  }

  private dispatchPending(): void {
    while (this.pendingQueue.length > 0) {
      const slotIndex = this.workers.findIndex((s) => s.inflight === 0);
      if (slotIndex === -1) return;
      const slot = this.workers[slotIndex];
      const item = this.pendingQueue.shift();
      // Defensive: findIndex returned a valid slot and the queue is non-empty.
      /* v8 ignore next */
      if (slot === undefined || item === undefined) return;
      slot.inflight++;
      this.speakSlotByRequestId.set(item.requestId, slotIndex);
      this.postToSlot(slot, {
        type: 'speak',
        requestId: item.requestId,
        text: item.text,
        voice: item.voice,
      });
    }
  }

  private handleWorkerMessage(slotIndex: number, slot: WorkerSlot, msg: WorkerOutbound): void {
    switch (msg.type) {
      case 'loadProgress': {
        this.onLoadProgress(slotIndex, msg.requestId, msg.loaded, msg.total);
        return;
      }
      case 'loadDone': {
        this.onLoadDone(slotIndex, slot, msg.requestId);
        return;
      }
      case 'loadError': {
        this.onLoadError(slotIndex, msg.requestId, msg.message);
        return;
      }
      case 'warmupDone': {
        this.onWarmupSettled(slotIndex, msg.requestId, null);
        return;
      }
      case 'warmupError': {
        this.onWarmupSettled(slotIndex, msg.requestId, msg.message);
        return;
      }
      case 'speakReady': {
        this.onSpeakReady(msg.requestId, msg.audio, msg.samplingRate);
        return;
      }
      case 'speakError': {
        this.onSpeakError(msg.requestId, msg.message);
        return;
      }
      case 'workerReady': {
        this.onWorkerReady(slot);
        return;
      }
    }
  }

  private onLoadProgress(
    slotIndex: number,
    requestId: string,
    loaded: number,
    total: number
  ): void {
    // Only forward progress from slot 0 — it is the sole slot that downloads
    // (see load()). The others are started after it finishes and read the
    // weights from the transformers.js Cache API entry, so their progress
    // events would over-report.
    if (slotIndex !== 0) return;
    const pending = this.pendingLoad;
    if (pending === null) return;
    if (pending.loadRequestIdBySlot[0] !== requestId) return;
    pending.onProgress?.(loaded, total);
  }

  private onLoadDone(slotIndex: number, slot: WorkerSlot, requestId: string): void {
    const pending = this.pendingLoad;
    if (pending === null) return;
    if (pending.loadRequestIdBySlot[slotIndex] !== requestId) return;
    if (pending.loadDoneBySlot[slotIndex]) return;
    pending.loadDoneBySlot[slotIndex] = true;
    if (slotIndex === 0) this.fanOutLoadAfterDownload(pending);
    const warmupRequestId = newRequestId();
    pending.warmupRequestIdBySlot[slotIndex] = warmupRequestId;
    slot.inflight++;
    this.postToSlot(slot, {
      type: 'warmup',
      requestId: warmupRequestId,
      voice: pending.voice,
    });
  }

  private onLoadError(slotIndex: number, requestId: string, message: string): void {
    const pending = this.pendingLoad;
    if (pending === null) return;
    if (pending.loadRequestIdBySlot[slotIndex] !== requestId) return;
    // Fail-fast: a partial pool is meaningless. Reject the load() promise
    // and clear pendingLoad so subsequent stale messages from other slots
    // are ignored.
    this.rejectLoad(new Error(message));
  }

  private onWarmupSettled(slotIndex: number, requestId: string, errorMessage: string | null): void {
    // preloadVoice (voice-change) path: each fan-out warmup has its own
    // requestId in pendingPreloads.
    const preload = this.pendingPreloads.get(requestId);
    if (preload !== undefined) {
      this.pendingPreloads.delete(requestId);
      if (errorMessage === null) {
        preload.resolve();
      } else {
        preload.reject(new Error(errorMessage));
      }
      return;
    }
    // Load-lifecycle warmup: warmupError is best-effort — first speak just
    // pays the embedding-fetch cost. Both Done and Error count as settled.
    const pending = this.pendingLoad;
    if (pending === null) return;
    if (pending.warmupRequestIdBySlot[slotIndex] !== requestId) return;
    if (pending.warmupSettledBySlot[slotIndex]) return;
    pending.warmupSettledBySlot[slotIndex] = true;
    if (pending.loadDoneBySlot.every(Boolean) && pending.warmupSettledBySlot.every(Boolean)) {
      this.resolveLoad(pending);
    }
  }

  private onSpeakReady(requestId: string, audio: Float32Array, samplingRate: number): void {
    const entry = this.pendingSpeaks.get(requestId);
    if (entry === undefined) return;
    this.pendingSpeaks.delete(requestId);
    this.speakSlotByRequestId.delete(requestId);
    entry.resolveAudio({ audio, samplingRate });
  }

  private onSpeakError(requestId: string, message: string): void {
    const entry = this.pendingSpeaks.get(requestId);
    if (entry === undefined) return;
    this.pendingSpeaks.delete(requestId);
    this.speakSlotByRequestId.delete(requestId);
    entry.rejectAudio(new Error(message));
  }

  private onWorkerReady(slot: WorkerSlot): void {
    if (slot.inflight > 0) slot.inflight--;
    this.dispatchPending();
  }

  /**
   * Schedule a buffer for playback and return an object holding the `'ended'`
   * promise. The OUTER awaitable resolves once the source has been
   * `.start()`ed — that's the moment the chain can advance. The ended
   * promise is wrapped in an object so async/await's Promise unwrapping
   * doesn't accidentally flatten it into the outer resolution.
   */
  private async scheduleAudio(
    audio: Float32Array,
    samplingRate: number
  ): Promise<{ endedPromise: Promise<void> }> {
    this.audioCtx ??= new AudioContext();
    const ctx = this.audioCtx;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    const buffer = ctx.createBuffer(1, audio.length, samplingRate);
    buffer.copyToChannel(audio as Float32Array<ArrayBuffer>, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // Schedule at the previous buffer's end, or at the current playback clock
    // if inference has fallen behind playback (gap). Web Audio guarantees
    // sample-accurate playback when start() is called with a future time;
    // passing a past time is also valid — it plays immediately.
    const startTime = Math.max(this.nextStartTime, ctx.currentTime);
    this.nextStartTime = startTime + buffer.duration;
    this.scheduledSources.add(source);

    const endedPromise = new Promise<void>((resolve) => {
      const onEnded = (): void => {
        this.scheduledSources.delete(source);
        source.removeEventListener('ended', onEnded);
        resolve();
      };
      source.addEventListener('ended', onEnded);
      source.start(startTime);
    });
    return { endedPromise };
  }
}

let singletonService: WorkerKokoroTtsService | null = null;

export function getTtsService(): TtsService {
  // The `?? defaultWorkerFactory` fallback is only reachable in production; tests
  // always set workerFactoryOverride, so that branch stays defensive here.
  /* v8 ignore next */
  singletonService ??= new WorkerKokoroTtsService(workerFactoryOverride ?? defaultWorkerFactory);
  return singletonService;
}

export function _resetTtsServiceForTesting(): void {
  singletonService?.terminate();
  singletonService = null;
}
