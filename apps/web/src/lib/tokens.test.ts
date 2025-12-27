import { describe, it, expect } from 'vitest';
import { estimateTokenCount, formatTokenCount, formatContextLength } from './tokens';

describe('estimateTokenCount', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('estimates tokens for short text (approximately 1 token per 4 characters)', () => {
    // "Hello" = 5 characters ≈ 2 tokens (5/4 rounded up)
    expect(estimateTokenCount('Hello')).toBe(2);
  });

  it('estimates tokens for longer text', () => {
    // 100 characters ≈ 25 tokens
    const text = 'a'.repeat(100);
    expect(estimateTokenCount(text)).toBe(25);
  });

  it('rounds up partial tokens', () => {
    // 3 characters should still be 1 token, not 0
    expect(estimateTokenCount('abc')).toBe(1);
  });

  it('handles whitespace-only text', () => {
    expect(estimateTokenCount('   ')).toBe(1);
  });

  it('handles multi-line text', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    expect(estimateTokenCount(text)).toBe(5); // 21 chars / 4 = 5.25, rounded up = 6
  });
});

describe('formatTokenCount', () => {
  it('formats small numbers with commas', () => {
    expect(formatTokenCount(1000)).toBe('1,000');
    expect(formatTokenCount(500)).toBe('500');
  });

  it('formats large numbers with K suffix', () => {
    expect(formatTokenCount(10000)).toBe('10k');
    expect(formatTokenCount(128000)).toBe('128k');
  });

  it('formats very large numbers with M suffix', () => {
    expect(formatTokenCount(1000000)).toBe('1M');
    expect(formatTokenCount(2500000)).toBe('2.5M');
  });
});

describe('formatContextLength', () => {
  it('formats context length in k', () => {
    expect(formatContextLength(128000)).toBe('128k');
    expect(formatContextLength(200000)).toBe('200k');
  });

  it('formats context length in M for million+', () => {
    expect(formatContextLength(1000000)).toBe('1M');
    expect(formatContextLength(2000000)).toBe('2M');
  });

  it('handles small context lengths', () => {
    expect(formatContextLength(4096)).toBe('4k');
  });
});
