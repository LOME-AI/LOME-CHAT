import { describe, expect, it } from 'vitest';

import { COMPARISON_ROWS } from './comparison.js';

describe('COMPARISON_ROWS', () => {
  it('exposes a non-empty comparison table', () => {
    expect(COMPARISON_ROWS.length).toBeGreaterThan(0);
  });

  it('gives every row a non-empty label and boolean columns', () => {
    for (const row of COMPARISON_ROWS) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(typeof row.hushbox).toBe('boolean');
      expect(typeof row.others).toBe('boolean');
    }
  });

  it('frames every row as a HushBox advantage the others lack', () => {
    for (const row of COMPARISON_ROWS) {
      expect(row.hushbox).toBe(true);
      expect(row.others).toBe(false);
    }
  });

  it('has no duplicate labels', () => {
    const labels = COMPARISON_ROWS.map((row) => row.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
