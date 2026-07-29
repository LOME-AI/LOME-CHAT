// Document reader. Extracts the readable block elements of a rendered
// document (e.g. a blog article), chunks each block through the existing
// sentence pipeline, and plays the chunks in document order (with synthesis
// pipelined ahead of playback) through the shared
// Kokoro TTS engine — the same engine, chunker, splitter, and normalizer
// that chat read-aloud uses. Nothing here is forked from those; forking the
// engine would break the transformers.js model-cache dedup that depends on
// one identical kokoro-js config across every caller.
//
// Framework-agnostic (no React/Zustand import), like tts-stream-feeder.ts.
// The consumer (a UI island) supplies callbacks and drives start()/stop()
// from user gestures. start() MUST either be called from a click handler, so
// unlockAudio() runs inside the gesture (iOS AudioContext requirement), or be
// handed the AudioContext the consumer already unlocked inside that gesture.

import { createFastStartSplitter } from './fast-start-splitter';
import { SentenceChunker } from './sentence-chunker';
import { normalizeForSpeech } from './text-normalizer';
import { getTtsService, WORKER_POOL_SIZE } from './tts-engine';
import type { FastStartSplitter } from './fast-start-splitter';
import type { TtsService, TtsVoice } from './tts-engine';

/** Block elements read aloud, in document order. `pre` (code) is never read. */
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';

export type DocumentReaderState = 'idle' | 'loading' | 'speaking' | 'paused' | 'stopped' | 'error';

/** States during which a read is in progress (start() is a no-op; stop() acts). */
const ACTIVE_STATES: ReadonlySet<DocumentReaderState> = new Set(['loading', 'speaking', 'paused']);

export interface DocumentReaderChunk {
  /** Zero-based position of this chunk in the flat, document-order chunk list. */
  readonly index: number;
  /** The block element this chunk's text came from. */
  readonly blockEl: HTMLElement;
  /** The exact text passed to speak() (normalized: markdown stripped, URLs → "link"). */
  readonly text: string;
  /**
   * Character offsets of `text` within the block's normalized-source text,
   * i.e. within `normalizeForSpeech(blockEl.textContent)`. When the piece can
   * be located there, `text === normalizeForSpeech(blockEl.textContent).slice(
   * startOffset, endOffset)`; when it cannot, these span the whole block so the
   * highlighter degrades to a block-level highlight. The highlighter
   * reconstructs the identical coordinate string from the same DOM + normalizer
   * and tolerantly maps the span onto raw DOM text nodes to build a Range.
   */
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface CreateDocumentReaderOptions {
  /** The rendered document root (e.g. `article.prose-blog[data-reading]`). */
  readonly container: HTMLElement;
  /** Voice id, from `useA11yStore.ttsVoice`. */
  readonly voice: TtsVoice;
  /** Fires when a chunk becomes the current one, i.e. when its audio starts. */
  readonly onChunk: (e: DocumentReaderChunk) => void;
  /** Fires on every state transition. */
  readonly onState: (s: DocumentReaderState) => void;
  /** Forwards the engine's model-download progress as a 0–100 percentage. */
  readonly onDownloadProgress: (p: { pct: number }) => void;
}

export interface DocumentReader {
  /**
   * Load the model (first call downloads it) and play every chunk in order.
   * Resolves when the read finishes, is stopped, or fails. Engine failures are
   * surfaced via `onState('error')`, not by rejecting. Calling start() while a
   * read is already in progress (including while paused) is a no-op; calling it
   * again after a completed or stopped read replays from the beginning.
   *
   * `audioCtx` lets a caller that reaches start() only after an `await` (e.g.
   * a dynamic import) hand over a context it created and primed inside the
   * click itself: iOS unlock is per-AudioContext-instance and is lost across
   * an await, so the engine adopts this one as the context that plays.
   */
  start(audioCtx?: AudioContext): Promise<void>;
  /**
   * Halt audio and end the read, discarding the resume point. Idempotent; a
   * no-op unless loading, speaking, or paused.
   */
  stop(): void;
  /**
   * Halt audio and hold the position of the chunk currently being spoken. A
   * no-op unless speaking. resume() re-enters at that chunk, so the sentence
   * that was mid-playback is heard again from its start — the engine holds no
   * playback position across a stop, and pausing at sub-chunk resolution would
   * mean suspending the shared AudioContext that chat also plays through.
   */
  pause(): void;
  /**
   * Re-enter playback at the paused chunk. A no-op unless paused. Resolves like
   * start(): when the read finishes, is stopped, is paused again, or fails.
   * The model is already loaded, so no `loading` state is emitted and no
   * AudioContext is needed — the engine keeps the one adopted at start(). A
   * caller must still restore that context (browsers may have suspended it)
   * inside the gesture that calls resume(), before any `await`.
   */
  resume(): Promise<void>;
  /** Total number of chunks extracted from the container (known at construction). */
  readonly chunkCount: number;
}

/** True when `el` has an ancestor (below `container`) that is also a block. */
function hasBlockAncestor(el: HTMLElement, container: HTMLElement): boolean {
  let parent = el.parentElement;
  while (parent !== null && parent !== container) {
    if (parent.matches(BLOCK_SELECTOR)) return true;
    parent = parent.parentElement;
  }
  return false;
}

/**
 * Readable blocks in document order: outermost matches only (so a `<p>` inside
 * a `<blockquote>` is read once, as part of the blockquote), never inside `pre`.
 */
function extractBlocks(container: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  for (const el of container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
    if (el.closest('pre') !== null) continue;
    if (hasBlockAncestor(el, container)) continue;
    blocks.push(el);
  }
  return blocks;
}

/**
 * Split a block's raw text into normalized speak-pieces via the shared pipeline.
 *
 * The chunker is per block (a document-wide one would carry its code-fence flag
 * from one block into the next), but the splitter is passed in because its
 * fast-start budget belongs to the whole document: constructing it here would
 * split the opening sentences of every paragraph, which for ordinary prose is
 * the whole article.
 */
function piecesForBlock(raw: string, splitter: FastStartSplitter): string[] {
  const chunker = new SentenceChunker();
  const sentences = chunker.feed(raw);
  const tail = chunker.flush();
  if (tail !== null) sentences.push(tail);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    for (const piece of splitter.split(sentence)) pieces.push(piece);
  }
  return pieces;
}

interface OffsetSpan {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Locate each piece's span within the block's normalized text by a
 * document-order cursor search. A piece is a trimmed slice of a normalized
 * sentence, and a normalized sentence is a substring of the whole block's
 * normalized text (same normalizeForSpeech; the chunker only trims at sentence
 * boundaries it finds in the same text), so the search never misses. The
 * unreachable no-match branch emits a whole-block span, which the chunk
 * highlighter degrades to a whole-block highlight — the same fail-soft result
 * it gives any range it cannot map.
 */
function offsetsForPieces(normalized: string, pieces: string[]): OffsetSpan[] {
  const spans: OffsetSpan[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    const found = normalized.indexOf(piece, cursor);
    /* v8 ignore start */
    if (found === -1) {
      spans.push({ text: piece, startOffset: 0, endOffset: normalized.length });
      continue;
    }
    /* v8 ignore stop */
    const endOffset = found + piece.length;
    cursor = endOffset;
    spans.push({ text: piece, startOffset: found, endOffset });
  }
  return spans;
}

/** Build the flat, document-order chunk list with per-chunk normalized-text offsets. */
function buildChunks(container: HTMLElement): DocumentReaderChunk[] {
  const chunks: DocumentReaderChunk[] = [];
  // One splitter for the whole document: the fast-start budget is spent on the
  // document's opening sentences, not on each block's.
  const splitter = createFastStartSplitter();
  for (const blockEl of extractBlocks(container)) {
    const raw = blockEl.textContent;
    const normalized = normalizeForSpeech(raw);
    if (normalized.length === 0) continue;
    for (const span of offsetsForPieces(normalized, piecesForBlock(raw, splitter))) {
      chunks.push({ index: chunks.length, blockEl, ...span });
    }
  }
  return chunks;
}

/** Mutable per-reader state shared between createDocumentReader and runRead. */
interface ReaderContext {
  readonly chunks: DocumentReaderChunk[];
  readonly options: CreateDocumentReaderOptions;
  readonly ref: { value: DocumentReaderState };
  service: TtsService | null;
  /**
   * Index of the chunk playback (re-)enters at. It tracks the chunk currently
   * being spoken, so a pause leaves it pointing at the sentence the listener
   * was hearing. Only a pause preserves it: every other exit from a read clears
   * it, so a fresh start() always begins at chunk 0.
   */
  cursor: number;
}

// Read/write the state through functions, never a narrowed local: `ref.value`
// is mutated across awaits, and direct comparisons would be narrowed into
// contradictions by the compiler. readState returns the full union.
function readState(ctx: ReaderContext): DocumentReaderState {
  return ctx.ref.value;
}

function setState(ctx: ReaderContext, next: DocumentReaderState): void {
  ctx.ref.value = next;
  ctx.options.onState(next);
}

/** End a read for good: only a pause keeps the resume point alive. */
function endRead(ctx: ReaderContext, next: 'idle' | 'stopped' | 'error'): void {
  ctx.cursor = 0;
  setState(ctx, next);
}

/**
 * Mark a pre-issued speak's rejection handled, synchronously at issue time.
 * stop() rejects every pending speak, and the ordered playback loop never
 * awaits the ones issued ahead of the stop, so without this each of them
 * becomes an unhandled rejection. Failures are still reported by the ordered
 * await; this handler only claims the ones that await never reaches.
 */
function absorbRejectionNow(speaking: Promise<void>): void {
  void (async (): Promise<void> => {
    try {
      await speaking;
    } catch {
      // Reported on the ordered path, or deliberately dropped after a stop().
    }
  })();
}

/**
 * Play chunks in order from the cursor while the state stays 'speaking'. A
 * stop() flips the state to 'stopped' and a pause() flips it to 'paused', both
 * of which this loop observes to break; a non-stop speak failure flips it to
 * 'error'. Ends by returning the state to 'idle' when the read completes
 * untouched.
 *
 * speak() resolves when a chunk's audio has finished PLAYING, not when its
 * synthesis completes, so awaiting it before requesting the next chunk leaves
 * exactly one request in flight: the engine hands every request to worker slot
 * 0, the rest of the pool idles, and each inter-sentence gap costs a whole
 * synthesis (which also defeats the engine's gapless scheduler). Synthesis is
 * therefore pipelined ahead of playback, bounded to one outstanding request per
 * pool worker — unbounded issue would synthesize a whole article ahead of the
 * audio, since a document (unlike a chat stream) is fully known up front.
 * Playback order and the state machine are unchanged: the awaits stay ordered.
 */
async function playChunks(ctx: ReaderContext, tts: TtsService): Promise<void> {
  const { voice, onChunk } = ctx.options;
  const pending: { chunk: DocumentReaderChunk; speaking: Promise<void> }[] = [];
  // An index, not an iterator: an iterator would be rebuilt from the head of
  // the chunk list on every entry, which is exactly what a resume must not do.
  let unissued = ctx.cursor;
  // One outstanding speak per pool worker: the window is refilled as each
  // chunk's audio ends, so no worker sits idle while any chunk is unsynthesized.
  const fillWindow = (): void => {
    while (pending.length < WORKER_POOL_SIZE) {
      const next = ctx.chunks[unissued];
      if (next === undefined) return;
      unissued += 1;
      const speaking = tts.speak(next.text, voice);
      absorbRejectionNow(speaking);
      pending.push({ chunk: next, speaking });
    }
  };

  fillWindow();
  let current = pending.shift();
  while (current !== undefined) {
    if (readState(ctx) !== 'speaking') break;
    // Painted on the ordered path, not at issue time: a chunk becomes current
    // when the previous chunk's audio ends, not when its synthesis is requested.
    // The cursor moves with the paint, so it always names the audible chunk.
    ctx.cursor = current.chunk.index;
    onChunk(current.chunk);
    try {
      await current.speaking;
    } catch {
      // A stop() rejects the in-flight speak(); anything else is a real failure.
      // Only that case reaches the stop below, so the engine is stopped once:
      // stopRead() has already stopped it on the stop path.
      if (readState(ctx) !== 'speaking') break;
      // 'error' means silence. The engine rejects only the speaks bound to the
      // slot that failed, so the rest of the window survives and its audio
      // would play on after the read ended.
      tts.stop();
      endRead(ctx, 'error');
      return;
    }
    fillWindow();
    current = pending.shift();
  }
  if (readState(ctx) === 'speaking') endRead(ctx, 'idle');
}

/** Load the model (forwarding download progress), then play the chunks. */
async function runRead(ctx: ReaderContext, tts: TtsService): Promise<void> {
  const { voice, onDownloadProgress } = ctx.options;
  setState(ctx, 'loading');
  try {
    await tts.load(voice, (loaded, total) => {
      onDownloadProgress({ pct: total > 0 ? (loaded / total) * 100 : 0 });
    });
  } catch {
    endRead(ctx, 'error');
    return;
  }
  // stop() may have fired while load() was in flight (load has no cancel).
  if (readState(ctx) !== 'loading') return;
  setState(ctx, 'speaking');
  await playChunks(ctx, tts);
}

async function startRead(ctx: ReaderContext, audioCtx?: AudioContext): Promise<void> {
  // Already running: ignore. Restart is allowed from idle/stopped/error.
  if (ACTIVE_STATES.has(ctx.ref.value)) return;
  const tts = getTtsService();
  ctx.service = tts;
  // Must run inside the click gesture that called start() (iOS unlock), unless
  // the caller already unlocked a context in the gesture and hands it over.
  tts.unlockAudio(audioCtx);
  await runRead(ctx, tts);
}

function stopRead(ctx: ReaderContext): void {
  if (!ACTIVE_STATES.has(ctx.ref.value)) return;
  endRead(ctx, 'stopped');
  ctx.service?.stop();
}

/**
 * State is flipped before the engine is stopped, so that the speaks stop()
 * rejects — up to one per pool worker — are observed by the playback loop as a
 * deliberate halt rather than a synthesis failure. Same ordering as stopRead().
 */
function pauseRead(ctx: ReaderContext): void {
  if (readState(ctx) !== 'speaking') return;
  setState(ctx, 'paused');
  ctx.service?.stop();
}

async function resumeRead(ctx: ReaderContext): Promise<void> {
  if (readState(ctx) !== 'paused') return;
  // The engine is a singleton and the model is already loaded, so playback
  // re-enters directly; there is nothing to load and nothing to unlock.
  const tts = getTtsService();
  setState(ctx, 'speaking');
  await playChunks(ctx, tts);
}

export function createDocumentReader(options: CreateDocumentReaderOptions): DocumentReader {
  const ctx: ReaderContext = {
    chunks: buildChunks(options.container),
    options,
    ref: { value: 'idle' },
    service: null,
    cursor: 0,
  };
  return {
    start: (audioCtx?: AudioContext) => startRead(ctx, audioCtx),
    stop: () => {
      stopRead(ctx);
    },
    pause: () => {
      pauseRead(ctx);
    },
    resume: () => resumeRead(ctx),
    get chunkCount(): number {
      return ctx.chunks.length;
    },
  };
}
