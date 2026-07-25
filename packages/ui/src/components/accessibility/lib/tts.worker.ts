// Dedicated Web Worker that hosts the kokoro-js KokoroTTS instance and its
// underlying @huggingface/transformers + onnxruntime-web runtime. The
// engine in tts-engine.ts (main thread) spawns a pool of these workers and
// dispatches one sentence at a time per worker; each worker emits
// `workerReady` after every speak/warmup completion so the engine can mark
// the slot idle and dispatch the next queued sentence.
//
// The handler logic is exported as `createWorkerHandler(ctx)` so tests can
// drive it without spawning a real worker. The worker globals are wired
// up at module bottom, guarded so the test environment (vitest jsdom) does
// not accidentally register a top-level listener.
//
// kokoro-js is imported statically: this module only loads inside the
// dedicated worker thread (main thread imports nothing from kokoro-js),
// so there's no module-graph pollution concern. Tests mock the import
// via vi.mock(). Static import also lets Vite bundle the worker as a
// single IIFE chunk — dynamic imports inside a worker would require
// `worker.format: 'es'` config, which we're avoiding.

import { KokoroTTS, env } from 'kokoro-js';

import { TTS_MODEL_DOWNLOAD_BYTES, TTS_ORT_WASM_PATH } from '@hushbox/shared';

import type { WorkerInbound, WorkerOutbound } from './tts-worker-protocol';

// Pin onnxruntime-web's WASM location so the deployed CSP can enclose every
// fetch the model download makes. Its default is a third-party jsdelivr CDN
// URL; pointing it at a same-origin path (where the build self-hosts the
// matching .wasm/.mjs) keeps the runtime same-origin with no CDN host in the
// policy. kokoro-js re-exports the @huggingface/transformers `env` as a thin
// wrapper exposing ONLY this `wasmPaths` setter — there is no `env.backends`
// tree to reach through. The model host itself is not pinned here: transformers
// already defaults to https://huggingface.co, which the SPA connect-src
// allowlist (TTS_MODEL_CONNECT_SRC) covers.
env.wasmPaths = TTS_ORT_WASM_PATH;

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// q8 on WASM keeps the download to ~90 MB (vs ~330 MB at fp32). The CPU
// can't take advantage of full-precision math anyway, and the worker pool
// delivers comparable throughput on WASM — fp32/WebGPU support was removed.
const DTYPE = 'q8' as const;
const DEVICE = 'wasm' as const;
// Multi-word sentence with mixed punctuation: makes the first warmup
// generation exercise a wider set of ORT kernel shapes so the user's
// first real sentence doesn't pay graph-compilation cost.
const WARMUP_TEXT = 'Hello, this warms up the speech engine.';

interface KokoroTtsInstance {
  generate(
    text: string,
    options: { voice: string }
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

interface KokoroProgressEvent {
  status?: string;
  file?: string;
  loaded?: number;
  total?: number;
}

export interface WorkerContext {
  postMessage(msg: WorkerOutbound, transfer?: Transferable[]): void;
}

export function createWorkerHandler(ctx: WorkerContext): (msg: WorkerInbound) => Promise<void> {
  let tts: KokoroTtsInstance | null = null;
  // Serializes generations so the single ONNX session is never invoked
  // concurrently (concurrent generate() calls produce undefined behavior).
  // The engine should only ever dispatch one speak at a time per worker;
  // the chain keeps the worker correct even if a test or a future engine
  // bug double-posts.
  let generationChain: Promise<void> = Promise.resolve();
  const cancelled = new Set<string>();

  function postWorkerReady(): void {
    ctx.postMessage({ type: 'workerReady' });
  }

  async function handleLoad(requestId: string): Promise<void> {
    // transformers reports {loaded,total} PER FILE, and the hub files download
    // concurrently: config/tokenizer JSON (a few KB), the voice embedding, and
    // the q8 weights (99.4% of the bytes). Forwarding one file's pair makes the
    // bar read 100% the instant the first JSON lands, then drop to ~0% when the
    // weights start. The worker is the only layer that still has file identity
    // — the worker protocol carries none — so the download-wide sum is formed
    // here, which also keeps the accessibility widget's byte readout, rate, and
    // ETA counting one download instead of restarting per file.
    const bytesByFile = new Map<string | undefined, { loaded: number; total: number }>();

    function aggregate(): { loaded: number; total: number } {
      let loaded = 0;
      let total = 0;
      for (const file of bytesByFile.values()) {
        loaded += file.loaded;
        total += file.total;
      }
      // Floor the denominator with the known first-listen size so files the hub
      // has not announced yet cannot inflate the percentage.
      return { loaded, total: Math.max(total, TTS_MODEL_DOWNLOAD_BYTES) };
    }

    try {
      tts = await (
        KokoroTTS.from_pretrained as unknown as (
          modelId: string,
          options: {
            dtype: string;
            device: 'wasm';
            progress_callback: (event: KokoroProgressEvent) => void;
          }
        ) => Promise<KokoroTtsInstance>
      )(MODEL_ID, {
        dtype: DTYPE,
        device: DEVICE,
        progress_callback: (event) => {
          if (typeof event.loaded === 'number' && typeof event.total === 'number') {
            bytesByFile.set(event.file, { loaded: event.loaded, total: event.total });
            ctx.postMessage({ type: 'loadProgress', requestId, ...aggregate() });
          }
        },
      });
      // The floored denominator would otherwise leave consumers a few percent
      // short of complete for the whole warmup.
      const { total } = aggregate();
      ctx.postMessage({ type: 'loadProgress', requestId, loaded: total, total });
      ctx.postMessage({ type: 'loadDone', requestId });
    } catch (error) {
      ctx.postMessage({
        type: 'loadError',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleWarmup(requestId: string, voice: string): Promise<void> {
    if (tts === null) {
      ctx.postMessage({
        type: 'warmupError',
        requestId,
        message: 'TTS engine is not loaded',
      });
      postWorkerReady();
      return;
    }
    try {
      await tts.generate(WARMUP_TEXT, { voice });
      ctx.postMessage({ type: 'warmupDone', requestId });
    } catch (error) {
      ctx.postMessage({
        type: 'warmupError',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    postWorkerReady();
  }

  async function runSpeak(requestId: string, text: string, voice: string): Promise<void> {
    if (cancelled.has(requestId)) {
      cancelled.delete(requestId);
      return;
    }
    if (tts === null) {
      ctx.postMessage({
        type: 'speakError',
        requestId,
        message: 'TTS engine is not loaded',
      });
      return;
    }
    try {
      const result = await tts.generate(text, { voice });
      if (cancelled.has(requestId)) {
        cancelled.delete(requestId);
        return;
      }
      ctx.postMessage(
        {
          type: 'speakReady',
          requestId,
          audio: result.audio,
          samplingRate: result.sampling_rate,
        },
        [result.audio.buffer]
      );
    } catch (error) {
      ctx.postMessage({
        type: 'speakError',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handleSpeak(requestId: string, text: string, voice: string): void {
    // Enqueue is synchronous; execution happens later on the chain so a
    // `cancel` message can still be processed while a generation is running.
    // workerReady fires after every speak attempt — success, failure, or
    // cancelled-before-start — so the engine can decrement the slot's
    // inflight counter without special-casing.
    // eslint-disable-next-line promise/prefer-await-to-then, promise/always-return -- explicit chain: appending preserves enqueue order without awaiting; the async callback's implicit return is a Promise<void>
    generationChain = generationChain.then(async () => {
      await runSpeak(requestId, text, voice);
      postWorkerReady();
    });
  }

  function handleCancel(requestId: string): void {
    cancelled.add(requestId);
  }

  return async function handleMessage(msg: WorkerInbound): Promise<void> {
    switch (msg.type) {
      case 'load': {
        await handleLoad(msg.requestId);
        return;
      }
      case 'warmup': {
        await handleWarmup(msg.requestId, msg.voice);
        return;
      }
      case 'speak': {
        handleSpeak(msg.requestId, msg.text, msg.voice);
        return;
      }
      case 'cancel': {
        handleCancel(msg.requestId);
        return;
      }
    }
  };
}

// Auto-register the listener when running inside a real DedicatedWorker.
// `importScripts` is worker-only and is undefined in vitest's environment,
// so this guard keeps tests from accidentally setting up a global handler.
declare const importScripts: unknown;
const inWorker = typeof importScripts === 'function';
if (inWorker) {
  const ctx: WorkerContext = {
    postMessage(msg, transfer = []) {
      (
        globalThis as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }
      ).postMessage(msg, transfer);
    },
  };
  const handler = createWorkerHandler(ctx);
  // eslint-disable-next-line sonarjs/post-message -- dedicated worker only receives messages from its parent window (the same origin); no need to verify origin
  self.addEventListener('message', (event: MessageEvent) => {
    void handler((event as MessageEvent<WorkerInbound>).data);
  });
}
