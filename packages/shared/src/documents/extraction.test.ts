import { describe, expect, it } from 'vitest';

import { MIN_LINES_FOR_DOCUMENT } from './extraction.js';

describe('MIN_LINES_FOR_DOCUMENT', () => {
  it('counts whole lines', () => {
    expect(Number.isInteger(MIN_LINES_FOR_DOCUMENT)).toBe(true);
  });

  it('takes more than a single line for a block to become a document', () => {
    expect(MIN_LINES_FOR_DOCUMENT).toBeGreaterThan(1);
  });
});
