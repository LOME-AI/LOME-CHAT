import { describe, it, expect } from 'vitest';

import { createFastStartSplitter, FAST_START_SENTENCE_COUNT } from './fast-start-splitter';
import { SPLIT_WORD_THRESHOLD } from './sentence-splitter';

function manyWords(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`).join(' ');
}

/**
 * 20 words with a comma at word 10 — above the halved threshold (13) so it
 * splits while the fast-start budget lasts, below the full threshold (25) so
 * it stays whole once the budget is spent. Both halves clear MIN_PIECE_WORDS.
 */
function makeSplittableSentence(prefix: string): string {
  const left = manyWords(`${prefix}L`, 10);
  const right = manyWords(`${prefix}R`, 10);
  return `${left}, ${right}.`;
}

describe('createFastStartSplitter', () => {
  it('splits the opening sentences at the halved threshold', () => {
    const splitter = createFastStartSplitter();

    const sentence = makeSplittableSentence('one');
    const words = sentence.split(/\s+/).length;
    expect(words).toBeGreaterThan(Math.ceil(SPLIT_WORD_THRESHOLD / 2));
    expect(words).toBeLessThanOrEqual(SPLIT_WORD_THRESHOLD);

    const pieces = splitter.split(sentence);

    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toContain('oneL0');
    expect(pieces[1]).toContain('oneR0');
  });

  it('falls back to the full threshold once the fast-start budget is spent', () => {
    const splitter = createFastStartSplitter();
    for (let index = 0; index < FAST_START_SENTENCE_COUNT; index++) {
      splitter.split(makeSplittableSentence(`early${String(index)}`));
    }

    const pieces = splitter.split(makeSplittableSentence('later'));

    expect(pieces).toHaveLength(1);
  });

  it('counts sentences per splitter, so a second splitter starts fresh', () => {
    const first = createFastStartSplitter();
    for (let index = 0; index <= FAST_START_SENTENCE_COUNT; index++) {
      first.split(makeSplittableSentence(`spent${String(index)}`));
    }

    const second = createFastStartSplitter();

    expect(second.split(makeSplittableSentence('fresh'))).toHaveLength(2);
  });

  it('leaves a sentence under the halved threshold whole', () => {
    const splitter = createFastStartSplitter();

    expect(splitter.split('Short enough, by far.')).toEqual(['Short enough, by far.']);
  });
});
