import process from 'node:process';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDocumentReader, type DocumentReaderState } from './document-reader';
import { normalizeForSpeech } from './text-normalizer';
import { WORKER_POOL_SIZE } from './tts-engine';
import type { TtsService, TtsVoice } from './tts-engine';

// The reader composes the real getTtsService() singleton internally, so the
// engine is mocked at that single seam. `hoisted.service` is swapped per test.
const hoisted = vi.hoisted(() => ({ service: null as TtsService | null }));

vi.mock('./tts-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tts-engine')>();
  return {
    ...actual,
    getTtsService: (): TtsService => {
      if (hoisted.service === null) throw new Error('test service not set');
      return hoisted.service;
    },
  };
});

/** One outstanding speak(), settled individually by the test. */
interface SpeakDeferred {
  resolve: () => void;
  reject: (e: Error) => void;
}

interface FakeTts {
  service: TtsService;
  spoken: { text: string; voice: TtsVoice }[];
  loadCalls: TtsVoice[];
  stopCalls: number;
  unlockCalls: number;
  /** The context argument of each unlockAudio() call, in order. */
  unlockContexts: (AudioContext | undefined)[];
  /** Handles for each speak() made under `perCallSpeakGate`, in call order. */
  speakDeferreds: SpeakDeferred[];
}

interface FakeOptions {
  /** Invoke the load progress callback with these (loaded,total) pairs before resolving. */
  progress?: [number, number][];
  /** Reject load() with this error instead of resolving. */
  loadError?: Error;
  /** When set, speak() returns a promise controlled by the test via `speakGate`. */
  speakGate?: { promise: Promise<void> };
  /**
   * When set, every speak() returns its OWN pending promise, settled through
   * `speakDeferreds`. The shared `speakGate` settles every outstanding speak at
   * once, which cannot express several concurrent speaks held open separately.
   */
  perCallSpeakGate?: boolean;
}

function makeFakeTts(options: FakeOptions = {}): FakeTts {
  const spoken: { text: string; voice: TtsVoice }[] = [];
  const speakDeferreds: SpeakDeferred[] = [];
  const loadCalls: TtsVoice[] = [];
  let stopCalls = 0;
  let unlockCalls = 0;
  const unlockContexts: (AudioContext | undefined)[] = [];
  let loaded = false;
  const service: TtsService = {
    load: vi.fn((voice: TtsVoice, onProgress?: (loaded: number, total: number) => void) => {
      loadCalls.push(voice);
      for (const [l, t] of options.progress ?? []) onProgress?.(l, t);
      if (options.loadError !== undefined) return Promise.reject(options.loadError);
      loaded = true;
      return Promise.resolve();
    }),
    isLoaded: vi.fn(() => loaded),
    preloadVoice: vi.fn(() => Promise.resolve()),
    // Deliberately NOT a vi.fn under perCallSpeakGate: vitest attaches its own
    // settled-result handler to every promise a mock returns, which marks the
    // rejection handled and makes any "no unhandled rejection" assertion
    // vacuous. A plain function keeps those rejections genuinely unhandled.
    speak:
      options.perCallSpeakGate === true
        ? (text: string, voice: TtsVoice): Promise<void> => {
            spoken.push({ text, voice });
            return new Promise<void>((resolve, reject) => {
              speakDeferreds.push({
                resolve: () => {
                  resolve();
                },
                reject: (e: Error) => {
                  reject(e);
                },
              });
            });
          }
        : vi.fn((text: string, voice: TtsVoice) => {
            spoken.push({ text, voice });
            return options.speakGate === undefined ? Promise.resolve() : options.speakGate.promise;
          }),
    stop: vi.fn(() => {
      stopCalls += 1;
    }),
    unlockAudio: vi.fn((existing?: AudioContext) => {
      unlockCalls += 1;
      unlockContexts.push(existing);
    }),
  };
  return {
    service,
    spoken,
    loadCalls,
    get stopCalls(): number {
      return stopCalls;
    },
    get unlockCalls(): number {
      return unlockCalls;
    },
    unlockContexts,
    speakDeferreds,
  } as FakeTts;
}

/** Yield a macrotask so every runnable microtask chain reaches its next await. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** `count` single-sentence chunks in one paragraph. */
function sentences(count: number): string {
  return Array.from(
    { length: count },
    (_unused, index) => `Sentence number ${String(index)}.`
  ).join(' ');
}

function makeContainer(html: string): HTMLElement {
  const el = document.createElement('article');
  el.innerHTML = html;
  return el;
}

function trackStates(): {
  states: DocumentReaderState[];
  onState: (s: DocumentReaderState) => void;
} {
  const states: DocumentReaderState[] = [];
  return {
    states,
    onState: (s): void => {
      states.push(s);
    },
  };
}

const noop = (): void => {};

beforeEach(() => {
  hoisted.service = null;
});

describe('createDocumentReader — extraction', () => {
  it('extracts p/h1..h6/li/blockquote in document order and skips pre', () => {
    const container = makeContainer(
      '<h2>Title</h2><p>First para.</p><pre><code>const x = 1;</code></pre>' +
        '<ul><li>Item one.</li></ul><blockquote>A quote.</blockquote>'
    );
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    expect(reader.chunkCount).toBe(4);
  });

  it('does not read the contents of a pre block', () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<pre><code>secret code line.</code></pre><p>Spoken.</p>');
    const chunks: string[] = [];
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: (e): void => {
        chunks.push(e.text);
      },
      onState: noop,
      onDownloadProgress: noop,
    });
    expect(reader.chunkCount).toBe(1);
    expect(chunks).toEqual([]); // not fired until start
  });

  it('skips a matched block nested inside a pre', () => {
    // Built via append() so the <p>-in-<pre> nesting survives (innerHTML
    // parsing would reparent it). Guards code blocks that contain block markup.
    const container = document.createElement('article');
    const pre = document.createElement('pre');
    const buried = document.createElement('p');
    buried.textContent = 'Do not read this code.';
    pre.append(buried);
    const outside = document.createElement('p');
    outside.textContent = 'Read this.';
    container.append(pre, outside);
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    expect(reader.chunkCount).toBe(1);
  });

  it('takes the outer block when block elements nest (blockquote > p read once)', () => {
    const container = makeContainer('<blockquote><p>Nested quote text.</p></blockquote>');
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    // One chunk, not two — the inner <p> is not double-counted.
    expect(reader.chunkCount).toBe(1);
  });

  it('skips blocks whose text is empty or whitespace only', () => {
    const container = makeContainer('<p>   </p><p>Real.</p><h3></h3>');
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    expect(reader.chunkCount).toBe(1);
  });

  it('emits zero chunks for an empty container', () => {
    const container = makeContainer('');
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    expect(reader.chunkCount).toBe(0);
  });
});

describe('createDocumentReader — chunking & offsets', () => {
  it('splits a block into sentence chunks via the shared pipeline', () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<p>First sentence. Second sentence.</p>');
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    expect(reader.chunkCount).toBe(2);
  });

  it('offsets index into normalizeForSpeech(block.textContent) — text equals that slice', async () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<p>First sentence. Second sentence.</p>');
    const block = container.querySelector('p')!;
    const normalized = normalizeForSpeech(block.textContent);
    const chunks: { blockEl: HTMLElement; text: string; startOffset: number; endOffset: number }[] =
      [];
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: (e): void => {
        chunks.push({
          blockEl: e.blockEl,
          text: e.text,
          startOffset: e.startOffset,
          endOffset: e.endOffset,
        });
      },
      onState: noop,
      onDownloadProgress: noop,
    });
    await reader.start();
    expect(chunks).toHaveLength(2);
    for (const c of chunks) {
      expect(c.blockEl).toBe(block);
      expect(normalized.slice(c.startOffset, c.endOffset)).toBe(c.text);
    }
    // Spans are in document order and non-overlapping.
    expect(chunks[0]!.startOffset).toBe(0);
    expect(chunks[1]!.startOffset).toBeGreaterThanOrEqual(chunks[0]!.endOffset);
  });

  it('assigns a monotonic index across all chunks', async () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<p>One. Two.</p><p>Three.</p>');
    const indices: number[] = [];
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: (e): void => {
        indices.push(e.index);
      },
      onState: noop,
      onDownloadProgress: noop,
    });
    await reader.start();
    expect(indices).toEqual([0, 1, 2]);
  });

  it('resolves offsets against the normalized-source text even when normalization rewrites content', async () => {
    // A raw URL normalizes to "link", so the emitted chunk text ("... link ...")
    // is not a literal substring of the RAW textContent — but IS a substring of
    // the normalized-source text, which is the offset coordinate system. The
    // span therefore still resolves against normalizeForSpeech(textContent).
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<p>See https://example.com now.</p>');
    const block = container.querySelector('p')!;
    const normalized = normalizeForSpeech(block.textContent);
    const chunks: { text: string; startOffset: number; endOffset: number }[] = [];
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: (e): void => {
        chunks.push({ text: e.text, startOffset: e.startOffset, endOffset: e.endOffset });
      },
      onState: noop,
      onDownloadProgress: noop,
    });
    await reader.start();
    expect(chunks).toHaveLength(1);
    expect(normalized.slice(chunks[0]!.startOffset, chunks[0]!.endOffset)).toBe(chunks[0]!.text);
    expect(chunks[0]!.text).toContain('link');
  });

  it('chunks a block whose text has no terminal punctuation (chunker flush path)', async () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<h2>Heading with no period</h2>');
    const block = container.querySelector('h2')!;
    const normalized = normalizeForSpeech(block.textContent);
    const chunks: { text: string; startOffset: number; endOffset: number }[] = [];
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: (e): void => {
        chunks.push({ text: e.text, startOffset: e.startOffset, endOffset: e.endOffset });
      },
      onState: noop,
      onDownloadProgress: noop,
    });
    await reader.start();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('Heading with no period');
    expect(normalized.slice(chunks[0]!.startOffset, chunks[0]!.endOffset)).toBe(chunks[0]!.text);
  });
});

describe('createDocumentReader — playback & state machine', () => {
  it('unlocks audio, loads with the passed voice, and speaks every chunk sequentially', async () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<p>Alpha. Beta.</p>');
    const reader = createDocumentReader({
      container,
      voice: 'bm_george',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    await reader.start();
    expect(fake.unlockCalls).toBe(1);
    expect(fake.loadCalls).toEqual(['bm_george']);
    expect(fake.spoken.map((s) => s.text)).toEqual(['Alpha.', 'Beta.']);
    expect(fake.spoken.every((s) => s.voice === 'bm_george')).toBe(true);
  });

  it('hands start()’s AudioContext to the engine so the gesture-unlocked one plays', async () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<p>Alpha.</p>');
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    const audioCtx = {} as AudioContext;
    await reader.start(audioCtx);
    expect(fake.unlockContexts).toEqual([audioCtx]);
  });

  it('leaves the engine to create its own context when start() is given none', async () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<p>Alpha.</p>');
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    await reader.start();
    expect(fake.unlockContexts).toEqual([undefined]);
  });

  it('emits loading -> speaking -> idle across a full read', async () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<p>Only one.</p>');
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    await reader.start();
    expect(states).toEqual(['loading', 'speaking', 'idle']);
  });

  it('emits error and does not speak when the engine load fails', async () => {
    const fake = makeFakeTts({ loadError: new Error('load timed out') });
    hoisted.service = fake.service;
    const container = makeContainer('<p>Never spoken.</p>');
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    await reader.start();
    expect(states).toEqual(['loading', 'error']);
    expect(fake.spoken).toEqual([]);
  });

  it('forwards download progress as a percentage', async () => {
    const fake = makeFakeTts({ progress: [[45, 90]] });
    hoisted.service = fake.service;
    const container = makeContainer('<p>Hi.</p>');
    const pcts: number[] = [];
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: (p): void => {
        pcts.push(p.pct);
      },
    });
    await reader.start();
    expect(pcts).toEqual([50]);
  });

  it('reports 0% progress when total is zero (avoids divide-by-zero)', async () => {
    const fake = makeFakeTts({ progress: [[0, 0]] });
    hoisted.service = fake.service;
    const container = makeContainer('<p>Hi.</p>');
    const pcts: number[] = [];
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: (p): void => {
        pcts.push(p.pct);
      },
    });
    await reader.start();
    expect(pcts).toEqual([0]);
  });

  it('emits error when a chunk fails to speak mid-read', async () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    (fake.service.speak as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('speak boom'));
    const container = makeContainer('<p>One. Two.</p>');
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    await reader.start();
    expect(states).toEqual(['loading', 'speaking', 'error']);
  });
});

describe('createDocumentReader — stop()', () => {
  it('stops audio and transitions to stopped when speaking', async () => {
    let release!: () => void;
    const gate = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const fake = makeFakeTts({ speakGate: gate });
    hoisted.service = fake.service;
    const container = makeContainer('<p>One. Two. Three.</p>');
    const { states, onState } = trackStates();
    const painted: number[] = [];
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: (e): void => {
        painted.push(e.index);
      },
      onState,
      onDownloadProgress: noop,
    });
    const started = reader.start();
    // Let load + first speak dispatch.
    await Promise.resolve();
    await Promise.resolve();
    reader.stop();
    release();
    await started;
    expect(states).toContain('stopped');
    expect(states.at(-1)).toBe('stopped');
    expect(fake.stopCalls).toBe(1);
    // Playback stopped at the first chunk. Synthesis of later chunks may
    // already have been requested (it runs ahead of playback), so the pin is
    // on what became current, not on how many speaks were issued.
    expect(painted).toEqual([0]);
  });

  it('ends in stopped (not error) when stop() rejects the in-flight speak', async () => {
    // The real engine rejects a pending speak() when stop() is called; the
    // reader must treat that as cancellation, not an engine error.
    let rejectSpeak!: (e: Error) => void;
    const speakPromise = new Promise<void>((_resolve, reject) => {
      rejectSpeak = reject;
    });
    const fake = makeFakeTts();
    (fake.service.speak as ReturnType<typeof vi.fn>).mockReturnValueOnce(speakPromise);
    hoisted.service = fake.service;
    const container = makeContainer('<p>One. Two.</p>');
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    const started = reader.start();
    await Promise.resolve();
    await Promise.resolve();
    reader.stop();
    rejectSpeak(new Error('TTS speak was cancelled'));
    await started;
    expect(states.at(-1)).toBe('stopped');
    expect(states).not.toContain('error');
  });

  it('is idempotent — a second stop() does not re-emit or re-call engine stop', async () => {
    let release!: () => void;
    const gate = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const fake = makeFakeTts({ speakGate: gate });
    hoisted.service = fake.service;
    const container = makeContainer('<p>One. Two.</p>');
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    const started = reader.start();
    await Promise.resolve();
    await Promise.resolve();
    reader.stop();
    reader.stop();
    release();
    await started;
    expect(states.filter((s) => s === 'stopped')).toHaveLength(1);
    expect(fake.stopCalls).toBe(1);
  });

  it('is a no-op when never started', () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<p>One.</p>');
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    reader.stop();
    expect(states).toEqual([]);
    expect(fake.stopCalls).toBe(0);
  });

  it('stops during load — never reaches speaking', async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const fake = makeFakeTts();
    vi.mocked(fake.service.load).mockImplementationOnce(() => loadGate);
    hoisted.service = fake.service;
    const container = makeContainer('<p>One. Two.</p>');
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    const started = reader.start();
    await Promise.resolve();
    reader.stop();
    releaseLoad();
    await started;
    expect(states).toEqual(['loading', 'stopped']);
    expect(fake.spoken).toEqual([]);
  });

  it('can be restarted after a full read completes', async () => {
    const fake = makeFakeTts();
    hoisted.service = fake.service;
    const container = makeContainer('<p>Once.</p>');
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    await reader.start();
    await reader.start();
    expect(fake.spoken.map((s) => s.text)).toEqual(['Once.', 'Once.']);
    expect(states).toEqual(['loading', 'speaking', 'idle', 'loading', 'speaking', 'idle']);
  });

  it('ignores a start() while already running', async () => {
    let release!: () => void;
    const gate = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const fake = makeFakeTts({ speakGate: gate });
    hoisted.service = fake.service;
    const container = makeContainer('<p>One. Two.</p>');
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    const first = reader.start();
    await Promise.resolve();
    await Promise.resolve();
    const second = reader.start(); // ignored — already speaking
    await second;
    release();
    await first;
    // load called exactly once despite two start() calls.
    expect(fake.loadCalls).toHaveLength(1);
  });
});

describe('createDocumentReader — concurrent synthesis', () => {
  it('issues synthesis for later chunks before the current chunk finishes playing', async () => {
    const fake = makeFakeTts({ perCallSpeakGate: true });
    hoisted.service = fake.service;
    const container = makeContainer(`<p>${sentences(6)}</p>`);
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    expect(reader.chunkCount).toBe(6);
    const started = reader.start();
    await flush();
    // No speak has resolved yet, so nothing has finished playing.
    expect(fake.spoken).toHaveLength(WORKER_POOL_SIZE);

    reader.stop();
    for (const d of fake.speakDeferreds) d.resolve();
    await started;
  });

  it('paints only the chunk that is currently playing', async () => {
    const fake = makeFakeTts({ perCallSpeakGate: true });
    hoisted.service = fake.service;
    const container = makeContainer(`<p>${sentences(6)}</p>`);
    const painted: number[] = [];
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: (e): void => {
        painted.push(e.index);
      },
      onState: noop,
      onDownloadProgress: noop,
    });
    const started = reader.start();
    await flush();
    // Chunks 1..3 are synthesizing ahead; only chunk 0 is audible.
    expect(painted).toEqual([0]);

    fake.speakDeferreds[0]!.resolve();
    await flush();
    expect(painted).toEqual([0, 1]);

    reader.stop();
    for (const d of fake.speakDeferreds) d.resolve();
    await started;
  });

  it('never keeps more than the worker pool size of chunks in flight', async () => {
    const chunkCount = 10;
    const fake = makeFakeTts({ perCallSpeakGate: true });
    hoisted.service = fake.service;
    const container = makeContainer(`<p>${sentences(chunkCount)}</p>`);
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState: noop,
      onDownloadProgress: noop,
    });
    expect(reader.chunkCount).toBe(chunkCount);
    const started = reader.start();
    await flush();

    for (let resolved = 0; resolved < chunkCount; resolved += 1) {
      const inFlight = fake.spoken.length - resolved;
      expect(inFlight).toBeLessThanOrEqual(WORKER_POOL_SIZE);
      // The window is kept full: every idle worker has a chunk to synthesize.
      expect(inFlight).toBe(Math.min(WORKER_POOL_SIZE, chunkCount - resolved));
      fake.speakDeferreds[resolved]!.resolve();
      await flush();
    }
    await started;
    expect(fake.spoken).toHaveLength(chunkCount);
  });

  it('stops cleanly with a full window outstanding', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const fake = makeFakeTts({ perCallSpeakGate: true });
      hoisted.service = fake.service;
      const container = makeContainer(`<p>${sentences(6)}</p>`);
      const { states, onState } = trackStates();
      const reader = createDocumentReader({
        container,
        voice: 'af_heart',
        onChunk: noop,
        onState,
        onDownloadProgress: noop,
      });
      const started = reader.start();
      await flush();
      expect(fake.spoken).toHaveLength(WORKER_POOL_SIZE);

      reader.stop();
      // The real engine rejects every pending speak() when stop() is called.
      for (const d of fake.speakDeferreds) d.reject(new Error('TTS speak was cancelled'));
      await started;
      await flush();

      expect(states.at(-1)).toBe('stopped');
      expect(states).not.toContain('error');
      expect(fake.stopCalls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('resumes at the chunk that was playing, not at the first chunk', async () => {
    const fake = makeFakeTts({ perCallSpeakGate: true });
    hoisted.service = fake.service;
    const container = makeContainer(`<p>${sentences(6)}</p>`);
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    void reader.start();
    await flush();
    // Chunk 0's audio ends, so chunk 1 is the one now playing.
    fake.speakDeferreds[0]!.resolve();
    await flush();
    const spokenBeforePause = fake.spoken.length;

    reader.pause();
    for (const d of fake.speakDeferreds.slice(1)) d.reject(new Error('TTS speak was cancelled'));
    await flush();
    expect(states.at(-1)).toBe('paused');

    void reader.resume();
    await flush();
    expect(fake.spoken[spokenBeforePause]!.text).toBe('Sentence number 1.');

    reader.stop();
    for (const d of fake.speakDeferreds) d.resolve();
    await flush();
  });

  it('pauses cleanly with a full window outstanding', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const fake = makeFakeTts({ perCallSpeakGate: true });
      hoisted.service = fake.service;
      const container = makeContainer(`<p>${sentences(6)}</p>`);
      const { states, onState } = trackStates();
      const reader = createDocumentReader({
        container,
        voice: 'af_heart',
        onChunk: noop,
        onState,
        onDownloadProgress: noop,
      });
      const started = reader.start();
      await flush();
      expect(fake.spoken).toHaveLength(WORKER_POOL_SIZE);

      reader.pause();
      // The real engine rejects every pending speak() when it is stopped.
      for (const d of fake.speakDeferreds) d.reject(new Error('TTS speak was cancelled'));
      await started;
      await flush();

      expect(states.at(-1)).toBe('paused');
      expect(states).not.toContain('error');
      expect(fake.stopCalls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('starts again at the first chunk after a stop() from paused', async () => {
    const fake = makeFakeTts({ perCallSpeakGate: true });
    hoisted.service = fake.service;
    const container = makeContainer(`<p>${sentences(6)}</p>`);
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    void reader.start();
    await flush();
    fake.speakDeferreds[0]!.resolve();
    await flush();

    reader.pause();
    for (const d of fake.speakDeferreds.slice(1)) d.reject(new Error('TTS speak was cancelled'));
    await flush();
    // A paused read is still a read in progress, so start() must do nothing:
    // were it to act, it would be a second resume path that re-unlocks audio and
    // re-emits 'loading' before landing on the preserved cursor.
    const spokenWhilePaused = fake.spoken.length;
    const unlocksWhilePaused = fake.unlockCalls;
    void reader.start();
    await flush();
    expect(fake.spoken).toHaveLength(spokenWhilePaused);
    expect(fake.unlockCalls).toBe(unlocksWhilePaused);
    expect(states.at(-1)).toBe('paused');

    reader.stop();
    expect(states.at(-1)).toBe('stopped');
    const spokenBeforeRestart = fake.spoken.length;

    void reader.start();
    await flush();
    expect(fake.spoken[spokenBeforeRestart]!.text).toBe('Sentence number 0.');

    reader.stop();
    for (const d of fake.speakDeferreds) d.resolve();
    await flush();
  });

  it('ignores pause() unless a chunk is being spoken', async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const fake = makeFakeTts();
    vi.mocked(fake.service.load).mockImplementationOnce(() => loadGate);
    hoisted.service = fake.service;
    const container = makeContainer(`<p>${sentences(3)}</p>`);
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    reader.pause(); // idle
    expect(states).toEqual([]);
    const started = reader.start();
    await flush();
    reader.pause(); // loading
    releaseLoad();
    await started;
    expect(states).toEqual(['loading', 'speaking', 'idle']);
    expect(fake.stopCalls).toBe(0);
  });

  it('ignores resume() unless paused', async () => {
    const fake = makeFakeTts({ perCallSpeakGate: true });
    hoisted.service = fake.service;
    const container = makeContainer(`<p>${sentences(6)}</p>`);
    const { states, onState } = trackStates();
    const reader = createDocumentReader({
      container,
      voice: 'af_heart',
      onChunk: noop,
      onState,
      onDownloadProgress: noop,
    });
    await reader.resume(); // idle
    expect(states).toEqual([]);
    expect(fake.spoken).toEqual([]);

    const started = reader.start();
    await flush();
    await reader.resume(); // speaking
    expect(fake.spoken).toHaveLength(WORKER_POOL_SIZE);

    reader.stop();
    for (const d of fake.speakDeferreds) d.resolve();
    await started;
    await reader.resume(); // stopped
    expect(states.at(-1)).toBe('stopped');
  });

  it('silences the outstanding window when a chunk fails to synthesize mid-read', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const fake = makeFakeTts({ perCallSpeakGate: true });
      hoisted.service = fake.service;
      const container = makeContainer(`<p>${sentences(6)}</p>`);
      const { states, onState } = trackStates();
      const painted: number[] = [];
      const reader = createDocumentReader({
        container,
        voice: 'af_heart',
        onChunk: (e): void => {
          painted.push(e.index);
        },
        onState,
        onDownloadProgress: noop,
      });
      const started = reader.start();
      await flush();
      expect(fake.spoken).toHaveLength(WORKER_POOL_SIZE);

      // A real synthesis failure, not a stop(): the engine rejects only the
      // speaks bound to the failed worker slot, so the rest of the window
      // survives and its audio would play on unless the reader silences it.
      fake.speakDeferreds[0]!.reject(new Error('speak boom'));
      await flush();
      // One survivor completes; the reader's own stop() cancels the others.
      fake.speakDeferreds[1]!.resolve();
      for (const d of fake.speakDeferreds.slice(2)) d.reject(new Error('TTS speak was cancelled'));
      await started;
      await flush();

      expect(states.at(-1)).toBe('error');
      expect(fake.stopCalls).toBe(1);
      // No later chunk ever became current, and none was even requested.
      expect(painted).toEqual([0]);
      expect(fake.spoken).toHaveLength(WORKER_POOL_SIZE);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
