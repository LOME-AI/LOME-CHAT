import { describe, it, expect } from 'vitest';
import { estimateTokenCount, formatTokenCount, formatContextLength } from './tokens';

describe('estimateTokenCount', () => {
  it('returns 0 for a zero-length count', () => {
    expect(estimateTokenCount(0)).toBe(0);
  });

  it('estimates roughly 1 token per 4 characters', () => {
    expect(estimateTokenCount(5)).toBe(2);
  });

  it('estimates a longer count', () => {
    expect(estimateTokenCount(100)).toBe(25);
  });

  it('rounds up partial tokens', () => {
    expect(estimateTokenCount(3)).toBe(1);
  });
});

describe('formatTokenCount', () => {
  it('formats small numbers with commas', () => {
    expect(formatTokenCount(1000)).toBe('1,000');
    expect(formatTokenCount(500)).toBe('500');
  });

  it('formats large numbers with locale separators', () => {
    expect(formatTokenCount(10_000)).toBe('10,000');
    expect(formatTokenCount(128_000)).toBe('128,000');
  });

  it('formats very large numbers with locale separators', () => {
    expect(formatTokenCount(1_000_000)).toBe('1,000,000');
    expect(formatTokenCount(2_500_000)).toBe('2,500,000');
  });
});

describe('formatContextLength', () => {
  it('formats context length in k', () => {
    expect(formatContextLength(128_000)).toBe('128k');
    expect(formatContextLength(200_000)).toBe('200k');
  });

  it('formats context length in M for million+', () => {
    expect(formatContextLength(1_000_000)).toBe('1M');
    expect(formatContextLength(2_000_000)).toBe('2M');
  });

  it('handles small context lengths', () => {
    expect(formatContextLength(4096)).toBe('4k');
  });
});
