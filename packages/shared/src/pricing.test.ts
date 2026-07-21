import { describe, it, expect } from 'vitest';
import { applyFees, estimateTokenCount } from './pricing.js';
import { TOTAL_FEE_RATE } from './constants.js';

describe('applyFees', () => {
  it('applies the total fee rate to the base price', () => {
    expect(applyFees(1)).toBeCloseTo(1 + TOTAL_FEE_RATE, 10);
    expect(applyFees(10)).toBeCloseTo(10 * (1 + TOTAL_FEE_RATE), 10);
    expect(applyFees(100)).toBeCloseTo(100 * (1 + TOTAL_FEE_RATE), 10);
  });

  it('handles zero price', () => {
    expect(applyFees(0)).toBe(0);
  });

  it('handles very small prices', () => {
    expect(applyFees(0.000_01)).toBeCloseTo(0.000_01 * (1 + TOTAL_FEE_RATE), 10);
  });
});

describe('estimateTokenCount', () => {
  it('estimates tokens using chars/4 heuristic', () => {
    expect(estimateTokenCount('hello')).toBe(2); // 5 chars -> ceil(5/4) = 2
    expect(estimateTokenCount('hello world')).toBe(3); // 11 chars -> ceil(11/4) = 3
  });

  it('handles empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('handles single character', () => {
    expect(estimateTokenCount('a')).toBe(1);
  });

  it('handles exactly 4 characters', () => {
    expect(estimateTokenCount('abcd')).toBe(1);
  });

  it('handles 5 characters (rounds up)', () => {
    expect(estimateTokenCount('abcde')).toBe(2);
  });

  it('handles large text', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokenCount(text)).toBe(250);
  });
});
