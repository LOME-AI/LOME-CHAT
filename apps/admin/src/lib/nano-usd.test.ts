import { describe, it, expect } from 'vitest';
import { formatNanoUsd } from './nano-usd.js';

describe('formatNanoUsd', () => {
  it('formats whole dollars', () => {
    expect(formatNanoUsd('5000000000')).toBe('$5.00');
  });

  it('formats cents', () => {
    expect(formatNanoUsd('123450000000')).toBe('$123.45');
  });

  it('groups thousands', () => {
    expect(formatNanoUsd('1000000000000')).toBe('$1,000.00');
    expect(formatNanoUsd('-1234567000000000')).toBe('-$1,234,567.00');
  });

  it('formats a negative balance with a leading minus', () => {
    expect(formatNanoUsd('-2500000000')).toBe('-$2.50');
  });

  it('truncates sub-cent nano amounts toward zero', () => {
    expect(formatNanoUsd('9999999')).toBe('$0.00');
    expect(formatNanoUsd('-9999999')).toBe('-$0.00');
  });

  it('formats zero', () => {
    expect(formatNanoUsd('0')).toBe('$0.00');
  });

  it('handles amounts beyond safe float precision without drift', () => {
    expect(formatNanoUsd('9007199254740993000000000')).toBe('$9,007,199,254,740,993.00');
  });
});
