import { describe, expect, it } from 'vitest';

import { levenshtein } from './levenshtein.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('anthropic/claude-opus-4.6', 'anthropic/claude-opus-4.6')).toBe(0);
  });

  it('returns the length of the non-empty string when one input is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts a single substitution as distance 1', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('counts a single insertion as distance 1', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
  });

  it('counts a single deletion as distance 1', () => {
    expect(levenshtein('cats', 'cat')).toBe(1);
  });

  it('counts a transposition as two edits (no Damerau extension)', () => {
    expect(levenshtein('ab', 'ba')).toBe(2);
  });

  it('handles classic textbook examples', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('sunday', 'saturday')).toBe(3);
  });

  it('is symmetric', () => {
    expect(levenshtein('flaw', 'lawn')).toBe(levenshtein('lawn', 'flaw'));
  });

  it('measures realistic model-id edit distances', () => {
    // Classifier dropping the dot in version
    expect(levenshtein('claude-sonnet-4.6', 'claude-sonnet-46')).toBe(1);
    // Classifier replacing dot with hyphen
    expect(levenshtein('claude-sonnet-4.6', 'claude-sonnet-4-6')).toBe(1);
    // Wholly different model — distance dominated by length difference
    expect(levenshtein('anthropic/claude-opus-4.6', 'openai/gpt-5')).toBeGreaterThan(10);
  });

  it('handles unicode-safe character iteration via code units', () => {
    // No special unicode handling required — distance counts UTF-16 code units.
    expect(levenshtein('café', 'cafe')).toBe(1);
  });
});

// Uncoverable branch note: every `?? 0` fallback in levenshtein.ts is
// unreachable. The row buffers are dense arrays sized shorter.length + 1 and
// every index stays in [0, shorter.length]; codePointAt is always called
// in-range (it returns the code unit even for lone surrogates). The
// fallbacks exist only to satisfy noUncheckedIndexedAccess — strings and
// dense arrays cannot produce undefined here, and the helper that indexes
// them is module-private, so no off-contract input can reach them.
