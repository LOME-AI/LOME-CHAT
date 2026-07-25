// Chunk highlighter. Renders the reading indicator for the document reader:
// given a chunk's block element and its character offsets into the block's
// normalized-for-speech text (the coordinate space document-reader emits), it
// builds a DOM Range over the block's live text nodes and paints it with the
// CSS Custom Highlight API, falling back to a whole-block class where that API
// is unavailable. A chunk that cannot be mapped degrades to a whole-block
// highlight; nothing here ever throws into the reader's playback loop.
//
// Framework-agnostic (no React/Zustand import) like document-reader.ts, save
// for the shared reduced-motion signal, which must not be re-derived (a second
// implementation would drift from the widget's stop-animations toggle).

import { normalizeForSpeech } from './text-normalizer';
import { shouldReduceMotion } from '../../../hooks/use-reduced-motion';

// The registry name and class below are mirrored by the CSS in
// styles/reading-highlight.css; chunk-highlighter.test.ts pins that both sides
// use these exact strings, so the pairing cannot silently drift.
const HIGHLIGHT_NAME = 'tts-reading';
const BLOCK_CLASS = 'tts-reading-block';

// Non-global, for stateless single-character `.test` (a shared global regex
// would carry lastIndex between calls).
const WHITESPACE = /\s/;

export interface ChunkHighlightTarget {
  /** The block element the chunk's text came from. */
  readonly blockEl: HTMLElement;
  /** Start offset of the chunk within `normalizeForSpeech(blockEl.textContent)`. */
  readonly startOffset: number;
  /** End offset (exclusive) within the same normalized coordinate space. */
  readonly endOffset: number;
}

export interface ChunkHighlighter {
  /** Highlight one chunk, replacing any previously highlighted chunk. */
  highlight(target: ChunkHighlightTarget): void;
  /** Remove every highlight this highlighter has painted. */
  clear(): void;
}

/** One significant (non-whitespace) character with its raw text-node location. */
interface SignificantChar {
  readonly node: Text;
  readonly offset: number;
  readonly character: string;
}

/**
 * True when the browser exposes the CSS Custom Highlight API registry. This
 * module only ever runs client-side (the reader dynamic-imports it on a click),
 * so `CSS` is always present; support turns purely on the `highlights` member.
 */
function highlightApiSupported(): boolean {
  return 'highlights' in CSS;
}

function stripWhitespace(text: string): string {
  return text.replaceAll(/\s/g, '');
}

/** A whole-block Range, the degradation target when a span cannot be mapped. */
function blockRange(blockEl: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(blockEl);
  return range;
}

/**
 * The block's significant characters in document order, each tagged with the
 * raw text node and offset it lives at, so a matched run can become a Range.
 */
function significantChars(blockEl: HTMLElement): SignificantChar[] {
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  const chars: SignificantChar[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    const text = node as Text;
    const { data } = text;
    for (let index = 0; index < data.length; index++) {
      const character = data.charAt(index);
      if (!WHITESPACE.test(character)) chars.push({ node: text, offset: index, character });
    }
    node = walker.nextNode();
  }
  return chars;
}

function rangeFromWindow(window: readonly SignificantChar[]): Range | null {
  const first = window.at(0);
  const last = window.at(-1);
  /* v8 ignore next -- unreachable: the caller only builds a Range from a window
     that matched a non-empty target, so both ends exist; this guards the type
     checker's noUncheckedIndexedAccess only. */
  if (first === undefined || last === undefined) return null;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/**
 * Map a chunk's normalized-text span onto the block's raw DOM text nodes and
 * return a Range covering exactly it, or `null` when it cannot be located.
 *
 * The reader's offsets index `normalizeForSpeech(blockEl.textContent)`, which
 * differs from the raw text (collapsed whitespace, stripped markdown, URLs →
 * "link"). Rather than reconstruct that transform's offset arithmetic, we match
 * on the *significant* (non-whitespace) characters, which normalization only
 * ever deletes or shrink-replaces — never adds. We skip the significant
 * characters before the span, then compare the next run against the span's
 * significant characters; a single altered character (the "link" case) fails
 * the comparison and returns `null`, so the caller degrades to a whole-block
 * highlight.
 */
function rangeForSpan(blockEl: HTMLElement, startOffset: number, endOffset: number): Range | null {
  const normalized = normalizeForSpeech(blockEl.textContent);
  if (startOffset < 0 || endOffset > normalized.length || startOffset >= endOffset) return null;

  const targetSig = stripWhitespace(normalized.slice(startOffset, endOffset));
  if (targetSig.length === 0) return null;
  const sigBefore = stripWhitespace(normalized.slice(0, startOffset)).length;

  const window = significantChars(blockEl).slice(sigBefore, sigBefore + targetSig.length);
  if (window.map((entry) => entry.character).join('') !== targetSig) return null;
  return rangeFromWindow(window);
}

function applyFallbackBlock(blockEl: HTMLElement): void {
  blockEl.classList.add(BLOCK_CLASS);
}

function clearFallbackBlocks(container: HTMLElement): void {
  for (const el of container.querySelectorAll<HTMLElement>(`.${BLOCK_CLASS}`)) {
    el.classList.remove(BLOCK_CLASS);
  }
}

/** Scroll the block to the viewport centre, but only when it is off-screen. */
function scrollBlockIntoView(blockEl: HTMLElement): void {
  const rect = blockEl.getBoundingClientRect();
  const offViewport = rect.bottom <= 0 || rect.top >= window.innerHeight;
  if (!offViewport) return;
  blockEl.scrollIntoView({
    block: 'center',
    behavior: shouldReduceMotion() ? 'instant' : 'smooth',
  });
}

function paint(target: ChunkHighlightTarget): void {
  if (highlightApiSupported()) {
    const range =
      rangeForSpan(target.blockEl, target.startOffset, target.endOffset) ??
      blockRange(target.blockEl);
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
    return;
  }
  applyFallbackBlock(target.blockEl);
}

export function createChunkHighlighter(container: HTMLElement): ChunkHighlighter {
  function clear(): void {
    if (highlightApiSupported()) CSS.highlights.delete(HIGHLIGHT_NAME);
    clearFallbackBlocks(container);
  }

  function highlight(target: ChunkHighlightTarget): void {
    try {
      clear();
      paint(target);
      scrollBlockIntoView(target.blockEl);
    } catch {
      // The highlight is presentational; a failure to paint it must never
      // break the reader's playback loop. Degrade to the block class.
      applyFallbackBlock(target.blockEl);
    }
  }

  return { highlight, clear };
}
