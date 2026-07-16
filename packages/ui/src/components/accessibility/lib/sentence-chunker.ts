/**
 * SentenceChunker — accumulates streamed tokens, emits completed sentences.
 * Used to feed Kokoro TTS sentence-by-sentence for chat-aloud streaming.
 *
 * Pre-buffer responsibility: only fenced code blocks. Fence content can
 * contain `.` followed by whitespace, which would trigger false sentence
 * boundaries; stripping fences during ingestion keeps boundary detection
 * honest. Everything else (links, inline code, bold, headings, lists, raw
 * URLs, HTML, tables) is left intact in the buffer and removed at emission
 * time via `normalizeForSpeech` — this preserves the inner text of inline
 * code spans (the LLM said "use `npm install`" — the user wants to hear
 * "npm install", not silence).
 *
 * Handles:
 * - Sentence boundaries on `.`, `!`, `?` followed by whitespace or end-of-stream
 * - Common abbreviations (Mr., Mrs., Ms., Dr., Prof., e.g., i.e., etc., vs., St.,
 *   U.S., a.m., p.m., Ph.D.)
 * - Leading ordered-list / bullet markers (`1.`, `2)`, `-`, `*`) — their trailing
 *   `.`/`)` is not a sentence boundary, so the bare ordinal is never spoken alone
 * - Fenced code blocks across feed() calls
 * - Multi-sentence batches in a single feed() call
 * - Markdown cleanup at emission time
 */

import { normalizeForSpeech } from './text-normalizer';

// Single-token abbreviations (the boundary `.` is their only/trailing dot) plus
// multi-dot forms (U.S., a.m., p.m., Ph.D.) whose final `.` is the candidate
// boundary; the lookbehind slice in findSentenceEnd ends at that final dot.
const SINGLE_DOT_ABBREVIATIONS =
  /\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|e\.g|i\.e|etc|Sr|Jr|Inc|Ltd|Co|Corp)\.\s*$/i;
const MULTI_DOT_ABBREVIATIONS = /(?:U\.S|[ap]\.m|Ph\.D)\.\s*$/i;
function isAbbreviation(before: string): boolean {
  return SINGLE_DOT_ABBREVIATIONS.test(before) || MULTI_DOT_ABBREVIATIONS.test(before);
}

// Leading list markers at line start: ordered (`1.`, `2)`) or bullet (`-`, `*`, `+`).
// The trailing `.`/`)` of an ordered marker must not register as a sentence end.
const ORDERED_LIST_MARKER = /(?:^|\n)[ \t]*\d+[.)]$/;

interface StripStep {
  readonly out: string;
  readonly consumed: number;
}

const PASSTHROUGH_CONSUMED = 1;

export class SentenceChunker {
  private buffer = '';
  private inCodeBlock = false;

  /** Feed a chunk of streamed text. Returns any newly-completed sentences. */
  feed(chunk: string): string[] {
    this.buffer += this.stripFences(chunk);
    const completed: string[] = [];
    while (this.buffer.length > 0) {
      const match = this.findSentenceEnd();
      if (match === -1) break;
      const raw = this.buffer.slice(0, match + 1).trim();
      this.buffer = this.buffer.slice(match + 1).trimStart();
      const normalized = normalizeForSpeech(raw);
      // A completed sentence always retains its terminator, which survives
      // normalisation, so the empty case never occurs here (defensive only).
      /* v8 ignore next */
      if (normalized.length > 0) completed.push(normalized);
    }
    return completed;
  }

  /** Return any remaining buffered text (for end-of-stream). Clears buffer. */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (remaining.length === 0) return null;
    const normalized = normalizeForSpeech(remaining);
    return normalized.length === 0 ? null : normalized;
  }

  private findSentenceEnd(): number {
    for (let index = 0; index < this.buffer.length; index++) {
      if (this.isSentenceBoundary(index)) return index;
    }
    return -1;
  }

  /**
   * True when the char at `index` ends a sentence: it is `.`/`!`/`?` followed
   * by whitespace or end-of-stream, and is not the trailing dot of an
   * abbreviation or a leading ordered-list marker.
   */
  private isSentenceBoundary(index: number): boolean {
    const ch = this.buffer.charAt(index);
    if (ch !== '.' && ch !== '!' && ch !== '?') return false;
    const next = this.buffer.charAt(index + 1);
    if (next !== '' && !/\s/.test(next)) return false;
    const before = this.buffer.slice(Math.max(0, index - 10), index + 1);
    if (isAbbreviation(before)) return false;
    return !this.isOrderedListMarker(index);
  }

  /**
   * True when the candidate boundary `.` is the dot of a leading ordered-list
   * marker (e.g. `1.` at the start of a line). Scans back to the line start so
   * arbitrarily-long ordinals and preceding text are handled, not just the
   * fixed lookbehind window used for abbreviations.
   */
  private isOrderedListMarker(index: number): boolean {
    const lineStart = this.buffer.lastIndexOf('\n', index) + 1;
    const lineHead = this.buffer.slice(lineStart, index + 1);
    return ORDERED_LIST_MARKER.test(lineHead);
  }

  /**
   * Strip fenced code blocks (```...```) from incoming text. State (open or
   * closed) persists across feed() calls so a fence opened in one chunk and
   * closed in another is correctly handled.
   */
  private stripFences(text: string): string {
    let out = '';
    let index = 0;
    while (index < text.length) {
      const step = this.fenceStep(text, index);
      out += step.out;
      index += step.consumed;
    }
    return out;
  }

  private fenceStep(text: string, index: number): StripStep {
    if (text.startsWith('```', index)) {
      this.inCodeBlock = !this.inCodeBlock;
      return { out: '', consumed: 3 };
    }
    if (this.inCodeBlock) {
      return { out: '', consumed: PASSTHROUGH_CONSUMED };
    }
    return { out: text.charAt(index), consumed: PASSTHROUGH_CONSUMED };
  }
}
