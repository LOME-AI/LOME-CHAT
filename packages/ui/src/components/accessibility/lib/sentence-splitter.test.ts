import { describe, it, expect } from 'vitest';

import { MIN_PIECE_WORDS, SPLIT_WORD_THRESHOLD, splitSentence } from './sentence-splitter';

function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function repeatWords(label: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${label}${String(index)}`).join(' ');
}

describe('splitSentence constants', () => {
  it('SPLIT_WORD_THRESHOLD is a positive integer', () => {
    expect(Number.isInteger(SPLIT_WORD_THRESHOLD)).toBe(true);
    expect(SPLIT_WORD_THRESHOLD).toBeGreaterThan(0);
  });

  it('MIN_PIECE_WORDS is positive and small enough that halved threshold can still split', () => {
    expect(Number.isInteger(MIN_PIECE_WORDS)).toBe(true);
    expect(MIN_PIECE_WORDS).toBeGreaterThan(0);
    // Halved threshold (used for the first few sentences) must accommodate
    // two minWords pieces, otherwise the fast-start path can never split.
    expect(MIN_PIECE_WORDS * 2).toBeLessThanOrEqual(Math.ceil(SPLIT_WORD_THRESHOLD / 2));
  });
});

describe('splitSentence — no split needed', () => {
  it('returns the sentence unchanged when under the threshold', () => {
    const short = 'Hello, world.';
    expect(splitSentence(short)).toEqual([short]);
  });

  it('returns the sentence unchanged when exactly at the threshold', () => {
    const text = `${repeatWords('w', SPLIT_WORD_THRESHOLD)}.`;
    expect(splitSentence(text)).toEqual([text]);
  });
});

describe('splitSentence — no eligible delimiter', () => {
  it('returns the sentence unchanged when over threshold but with no delimiter at all', () => {
    const text = `${repeatWords('w', SPLIT_WORD_THRESHOLD + 10)}.`;
    expect(splitSentence(text)).toEqual([text]);
  });
});

describe('splitSentence — single split', () => {
  it('splits at a semicolon into two pieces preserving the delimiter on the left', () => {
    const left = repeatWords('alpha', 15);
    const right = repeatWords('beta', 15);
    const input = `${left}; ${right}.`;
    const pieces = splitSentence(input);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toBe(`${left};`);
    expect(pieces[1]).toBe(`${right}.`);
  });

  it('splits at a colon when present', () => {
    const left = repeatWords('a', 15);
    const right = repeatWords('b', 15);
    const input = `${left}: ${right}.`;
    const pieces = splitSentence(input);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toBe(`${left}:`);
  });

  it('splits at an em-dash when present', () => {
    const left = repeatWords('a', 15);
    const right = repeatWords('b', 15);
    const input = `${left}—${right}.`;
    const pieces = splitSentence(input);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.endsWith('—')).toBe(true);
  });

  it('splits at an en-dash when present', () => {
    const left = repeatWords('a', 15);
    const right = repeatWords('b', 15);
    const input = `${left}–${right}.`;
    const pieces = splitSentence(input);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.endsWith('–')).toBe(true);
  });

  it('splits at a comma when no stronger delimiter is available', () => {
    const left = repeatWords('alpha', 15);
    const right = repeatWords('beta', 15);
    const input = `${left}, ${right}.`;
    const pieces = splitSentence(input);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toBe(`${left},`);
    expect(pieces[1]).toBe(`${right}.`);
  });
});

describe('splitSentence — multi split', () => {
  it('splits into ceil(words/threshold) pieces when delimiters allow', () => {
    const p1 = repeatWords('a', 20);
    const p2 = repeatWords('b', 20);
    const p3 = repeatWords('c', 20);
    const input = `${p1}; ${p2}; ${p3}.`;
    const pieces = splitSentence(input, 25);
    expect(pieces).toHaveLength(3);
    expect(wordCount(pieces[0]!)).toBe(20);
    expect(wordCount(pieces[1]!)).toBe(20);
    expect(wordCount(pieces[2]!)).toBe(20);
  });
});

describe('splitSentence — minimum-words constraint', () => {
  it('refuses a split whose right piece would be under MIN_PIECE_WORDS', () => {
    const longHead = repeatWords('h', 25);
    const shortTail = repeatWords('t', MIN_PIECE_WORDS - 1);
    const input = `${longHead}, ${shortTail}.`;
    expect(splitSentence(input, 20)).toEqual([input]);
  });

  it('refuses a split whose left piece would be under MIN_PIECE_WORDS', () => {
    const shortHead = repeatWords('h', MIN_PIECE_WORDS - 1);
    const longTail = repeatWords('t', 25);
    const input = `${shortHead}, ${longTail}.`;
    expect(splitSentence(input, 20)).toEqual([input]);
  });

  it('emits no piece below MIN_PIECE_WORDS across a multi-split', () => {
    const parts = [
      repeatWords('a', 10),
      repeatWords('b', 10),
      repeatWords('c', 10),
      repeatWords('d', 10),
    ];
    const input = `${parts[0]!}, ${parts[1]!}, ${parts[2]!}, ${parts[3]!}.`;
    const pieces = splitSentence(input, 12);
    for (const piece of pieces) {
      expect(wordCount(piece)).toBeGreaterThanOrEqual(MIN_PIECE_WORDS);
    }
  });
});

describe('splitSentence — delimiter tier preference', () => {
  it('prefers a tier-1 semicolon over a nearby tier-2 comma', () => {
    const a = repeatWords('a', 14);
    const b = repeatWords('b', 2);
    const c = repeatWords('c', 14);
    // Comma sits at word 14; semicolon sits at word 16. Both balanced
    // enough; the semicolon should win on tier weight.
    const input = `${a}, ${b}; ${c}.`;
    const pieces = splitSentence(input, 25);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.endsWith(';')).toBe(true);
  });
});

describe('splitSentence — false-positive exclusions', () => {
  it('does NOT split at a comma inside a numeric literal (1,000)', () => {
    const left = repeatWords('a', 20);
    const right = repeatWords('b', 10);
    const input = `${left} 1,000 ${right}.`;
    expect(splitSentence(input, 25)).toEqual([input]);
  });

  it('does NOT split at a hyphen inside a compound word (time-to-first)', () => {
    const left = repeatWords('a', 20);
    const right = repeatWords('b', 10);
    const input = `${left} time-to-first ${right}.`;
    expect(splitSentence(input, 25)).toEqual([input]);
  });

  it('DOES split at a hyphen with surrounding whitespace (used as an em-dash)', () => {
    const left = repeatWords('a', 15);
    const right = repeatWords('b', 15);
    const input = `${left} - ${right}.`;
    const pieces = splitSentence(input, 25);
    expect(pieces).toHaveLength(2);
  });
});

describe('splitSentence — fast-start behavior', () => {
  it('a halved threshold produces more pieces than the full threshold on the same input', () => {
    const parts = [
      repeatWords('w0_', 8),
      repeatWords('w1_', 8),
      repeatWords('w2_', 8),
      repeatWords('w3_', 8),
    ];
    const input = `${parts[0]!}, ${parts[1]!}, ${parts[2]!}, ${parts[3]!}.`;
    const full = splitSentence(input, SPLIT_WORD_THRESHOLD);
    const halved = splitSentence(input, Math.ceil(SPLIT_WORD_THRESHOLD / 2));
    expect(halved.length).toBeGreaterThan(full.length);
  });
});

describe('splitSentence — recursive subdivision', () => {
  it('subdivides a piece that remains over threshold after the greedy first pass', () => {
    // A tier-1 em-dash sits 42 words deep with closer tier-2 commas before
    // it. Tier weight makes the greedy pass pick the em-dash, producing a
    // 42-word left piece. With recursion, that left piece must be further
    // split so no emitted piece exceeds the threshold.
    const segments = Array.from({ length: 7 }, (_, index) => repeatWords(`s${String(index)}_`, 6));
    const leftPiece = segments.join(', ');
    const rightPiece = repeatWords('tail', 8);
    const input = `${leftPiece}—${rightPiece}.`;
    const pieces = splitSentence(input, 13);
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) {
      expect(wordCount(piece)).toBeLessThanOrEqual(13);
    }
  });
});

describe('splitSentence — whitespace and emptiness', () => {
  it('trims whitespace from every emitted piece', () => {
    const left = repeatWords('a', 15);
    const right = repeatWords('b', 15);
    const input = `${left};   ${right}.`;
    const pieces = splitSentence(input);
    for (const piece of pieces) {
      expect(piece).toBe(piece.trim());
    }
  });

  it('never emits an empty piece', () => {
    const left = repeatWords('a', 15);
    const right = repeatWords('b', 15);
    const input = `${left}; ${right}.`;
    const pieces = splitSentence(input);
    for (const piece of pieces) {
      expect(piece.length).toBeGreaterThan(0);
    }
  });

  it('returns an empty string unchanged (zero words)', () => {
    expect(splitSentence('')).toEqual(['']);
  });

  it('returns whitespace-only input unchanged (zero words)', () => {
    expect(splitSentence('     ')).toEqual(['     ']);
  });
});
