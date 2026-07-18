import { describe, expect, it } from 'vitest';

import { splitEmphasis } from './caption-emphasis.js';

describe('splitEmphasis', () => {
  it('returns the whole text as before when no emphasis is given', () => {
    expect(splitEmphasis('We built one thing.')).toEqual({
      before: 'We built one thing.',
      word: '',
      after: '',
    });
  });

  it('splits around the emphasis word', () => {
    expect(splitEmphasis('We built one thing.', 'one thing')).toEqual({
      before: 'We built ',
      word: 'one thing',
      after: '.',
    });
  });

  it('keeps the whole text when the emphasis is not found', () => {
    expect(splitEmphasis('We built one thing.', 'nope')).toEqual({
      before: 'We built one thing.',
      word: '',
      after: '',
    });
  });

  it('handles emphasis at the start', () => {
    expect(splitEmphasis('Never built.', 'Never')).toEqual({
      before: '',
      word: 'Never',
      after: ' built.',
    });
  });

  it('splits on the first occurrence only', () => {
    expect(splitEmphasis('one and one', 'one')).toEqual({
      before: '',
      word: 'one',
      after: ' and one',
    });
  });
});
