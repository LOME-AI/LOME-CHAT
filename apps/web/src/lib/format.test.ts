import { describe, it, expect } from 'vitest';
import { formatContextLength, formatPricePer1k } from './format';

describe('formatContextLength', () => {
  it('formats thousands as k', () => {
    expect(formatContextLength(128000)).toBe('128k');
    expect(formatContextLength(200000)).toBe('200k');
    expect(formatContextLength(131072)).toBe('131k');
  });

  it('formats millions as M', () => {
    expect(formatContextLength(1000000)).toBe('1M');
    expect(formatContextLength(2000000)).toBe('2M');
  });

  it('rounds to nearest k', () => {
    expect(formatContextLength(4096)).toBe('4k');
    expect(formatContextLength(8192)).toBe('8k');
  });

  it('handles exactly 1M boundary', () => {
    expect(formatContextLength(999999)).toBe('1000k');
    expect(formatContextLength(1000000)).toBe('1M');
  });
});

describe('formatPricePer1k', () => {
  it('formats standard prices without trailing zeros', () => {
    expect(formatPricePer1k(0.001)).toBe('$1');
    expect(formatPricePer1k(0.002)).toBe('$2');
  });

  it('formats prices less than $1 without trailing zeros', () => {
    expect(formatPricePer1k(0.00001)).toBe('$0.01');
    expect(formatPricePer1k(0.00003)).toBe('$0.03');
  });

  it('formats prices less than $0.01 without trailing zeros', () => {
    expect(formatPricePer1k(0.000003)).toBe('$0.003');
    expect(formatPricePer1k(0.000005)).toBe('$0.005');
  });

  it('formats very small prices without trailing zeros', () => {
    expect(formatPricePer1k(0.0000005)).toBe('$0.0005');
    expect(formatPricePer1k(0.00000059)).toBe('$0.00059');
  });

  it('handles zero price', () => {
    expect(formatPricePer1k(0)).toBe('$0');
  });
});
