/** Sentences longer than this (in words) get split. */
export const SPLIT_WORD_THRESHOLD = 25;

/**
 * Hard floor: never emit a piece smaller than this many words. Splits that
 * would produce a piece below the floor are rejected; if no valid split
 * exists the original sentence is returned unchanged.
 */
export const MIN_PIECE_WORDS = 6;

/**
 * Tier-1 delimiters (strong clause/phrase boundaries):
 * - `;` `:` `—` `–` — literal punctuation
 * - `\s-\s` — hyphen surrounded by whitespace, used as an em-dash on
 *   keyboards without a typographic dash. The whitespace constraint
 *   prevents splitting hyphenated words like `time-to-first-speech`.
 */
const TIER_1_PATTERN = /[;:—–]|\s-\s/g;

/**
 * Tier-2 delimiter (medium): a comma followed by whitespace. The trailing
 * whitespace requirement avoids splitting numeric literals like `1,000`.
 */
const TIER_2_PATTERN = /,\s/g;

const TIER_1_WEIGHT = 2;
const TIER_2_WEIGHT = 1;

interface SplitCandidate {
  /**
   * Index in the source text *after* the delimiter and any immediately
   * following whitespace. Slicing the source up to this index yields the
   * left piece (including the delimiter); slicing from this index yields
   * the right piece.
   */
  position: number;
  /** Word count of the slice `text.slice(0, position)`. */
  wordIdx: number;
  tier: 1 | 2;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function consumeTrailingWhitespace(text: string, fromIndex: number): number {
  let pos = fromIndex;
  while (pos < text.length && /\s/.test(text.charAt(pos))) pos++;
  return pos;
}

function collectCandidates(text: string, pattern: RegExp, tier: 1 | 2): SplitCandidate[] {
  const out: SplitCandidate[] = [];
  for (const match of text.matchAll(pattern)) {
    const matchEnd = match.index + match[0].length;
    const position = consumeTrailingWhitespace(text, matchEnd);
    out.push({
      position,
      wordIdx: countWords(text.slice(0, position)),
      tier,
    });
  }
  return out;
}

function findCandidates(text: string): SplitCandidate[] {
  const candidates = [
    ...collectCandidates(text, TIER_1_PATTERN, 1),
    ...collectCandidates(text, TIER_2_PATTERN, 2),
  ];
  candidates.sort((a, b) => a.position - b.position);
  return candidates;
}

function tierWeight(tier: 1 | 2): number {
  return tier === 1 ? TIER_1_WEIGHT : TIER_2_WEIGHT;
}

function pickBestCandidate(
  candidates: SplitCandidate[],
  cursorWord: number,
  totalWords: number,
  targetWord: number
): SplitCandidate | null {
  let best: { score: number; cand: SplitCandidate } | null = null;
  for (const cand of candidates) {
    if (cand.wordIdx <= cursorWord) continue;
    const leftWords = cand.wordIdx - cursorWord;
    const rightWords = totalWords - cand.wordIdx;
    if (leftWords < MIN_PIECE_WORDS || rightWords < MIN_PIECE_WORDS) continue;
    const distance = Math.abs(cand.wordIdx - targetWord);
    const score = tierWeight(cand.tier) - distance / totalWords;
    if (best === null || score > best.score) {
      best = { score, cand };
    }
  }
  return best?.cand ?? null;
}

function greedyPass(
  text: string,
  candidates: SplitCandidate[],
  totalWords: number,
  targetPieceCount: number
): string[] {
  const pieces: string[] = [];
  let cursorPos = 0;
  let cursorWord = 0;

  for (let pieceIndex = 1; pieceIndex < targetPieceCount; pieceIndex++) {
    const targetWord = (totalWords * pieceIndex) / targetPieceCount;
    const best = pickBestCandidate(candidates, cursorWord, totalWords, targetWord);
    if (best === null) break;
    const piece = text.slice(cursorPos, best.position).trim();
    // A chosen candidate always lies beyond the cursor (MIN_PIECE_WORDS apart),
    // so the sliced piece is never empty here — defensive only.
    /* v8 ignore next */
    if (piece.length > 0) pieces.push(piece);
    cursorPos = best.position;
    cursorWord = best.wordIdx;
  }

  const tail = text.slice(cursorPos).trim();
  // A candidate at the very end is skipped (rightWords < MIN_PIECE_WORDS), so
  // the cursor never reaches the end and the tail is never empty — defensive.
  /* v8 ignore next */
  if (tail.length > 0) pieces.push(tail);
  return pieces;
}

function subdivideOverThreshold(pieces: string[], wordThreshold: number): string[] {
  const subdivided: string[] = [];
  for (const piece of pieces) {
    if (countWords(piece) <= wordThreshold) {
      subdivided.push(piece);
    } else {
      subdivided.push(...splitSentence(piece, wordThreshold));
    }
  }
  return subdivided;
}

/**
 * Break `text` into 1+ pieces at natural clause boundaries.
 *
 * @param text - A single normalized sentence.
 * @param wordThreshold - Sentences strictly longer than this trigger splitting.
 *   Defaults to {@link SPLIT_WORD_THRESHOLD}.
 * @returns 1+ pieces, each respecting {@link MIN_PIECE_WORDS}. Returns
 *   `[text]` unchanged when the sentence is short enough, has no eligible
 *   delimiter, or every candidate would violate the minimum.
 */
export function splitSentence(
  text: string,
  wordThreshold: number = SPLIT_WORD_THRESHOLD
): string[] {
  const totalWords = countWords(text);
  if (totalWords <= wordThreshold) return [text];

  const candidates = findCandidates(text);
  if (candidates.length === 0) return [text];

  const targetPieceCount = Math.ceil(totalWords / wordThreshold);
  const pieces = greedyPass(text, candidates, totalWords, targetPieceCount);

  // greedyPass always yields at least the non-empty tail, so this never fires.
  /* v8 ignore next */
  if (pieces.length === 0) return [text];
  if (pieces.length === 1) return pieces;

  return subdivideOverThreshold(pieces, wordThreshold);
}
