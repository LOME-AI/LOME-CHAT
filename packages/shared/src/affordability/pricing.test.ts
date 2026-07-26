import { describe, it, expect } from 'vitest';
import { applyFees, estimateTokenCount } from './pricing.js';
import { CHARS_PER_TOKEN_STANDARD, TOTAL_FEE_RATE } from './constants.js';

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
  it('takes a character count, never the characters themselves', () => {
    expect(estimateTokenCount(5)).toBe(2);
    expect(estimateTokenCount(11)).toBe(3);
  });

  it('reads its ratio from the standard tier constant rather than a literal', () => {
    expect(estimateTokenCount(CHARS_PER_TOKEN_STANDARD)).toBe(1);
    expect(estimateTokenCount(CHARS_PER_TOKEN_STANDARD * 250)).toBe(250);
  });

  it('handles a zero-length count', () => {
    expect(estimateTokenCount(0)).toBe(0);
  });

  it('rounds a partial token up', () => {
    expect(estimateTokenCount(1)).toBe(1);
    expect(estimateTokenCount(5)).toBe(2);
  });

  it('rejects a negative count rather than reporting negative tokens', () => {
    expect(() => estimateTokenCount(-1)).toThrow(RangeError);
  });
});
