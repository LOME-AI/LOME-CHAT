import { describe, it, expect } from 'vitest';
import { customUserMessage, formatLockoutMessage } from './error-messages.js';

describe('formatLockoutMessage', () => {
  it('formats sub-minute lockouts as seconds', () => {
    expect(formatLockoutMessage(1)).toBe('Too many attempts. Try again in 1 second.');
    expect(formatLockoutMessage(45)).toBe('Too many attempts. Try again in 45 seconds.');
    expect(formatLockoutMessage(59)).toBe('Too many attempts. Try again in 59 seconds.');
  });

  it('formats sub-hour lockouts as minutes, rounding up', () => {
    expect(formatLockoutMessage(60)).toBe('Too many attempts. Try again in 1 minute.');
    expect(formatLockoutMessage(61)).toBe('Too many attempts. Try again in 2 minutes.');
    expect(formatLockoutMessage(120)).toBe('Too many attempts. Try again in 2 minutes.');
    expect(formatLockoutMessage(3599)).toBe('Too many attempts. Try again in 60 minutes.');
  });

  it('formats >=1h lockouts as hours, rounding up', () => {
    expect(formatLockoutMessage(3600)).toBe('Too many attempts. Try again in 1 hour.');
    expect(formatLockoutMessage(3601)).toBe('Too many attempts. Try again in 2 hours.');
    expect(formatLockoutMessage(7200)).toBe('Too many attempts. Try again in 2 hours.');
    expect(formatLockoutMessage(24 * 60 * 60)).toBe('Too many attempts. Try again in 24 hours.');
  });

  it('falls back for non-positive inputs', () => {
    expect(formatLockoutMessage(0)).toBe('Too many attempts. Try again in a moment.');
    expect(formatLockoutMessage(-5)).toBe('Too many attempts. Try again in a moment.');
  });

  it('falls back for non-finite inputs', () => {
    expect(formatLockoutMessage(Number.NaN)).toBe('Too many attempts. Try again in a moment.');
    expect(formatLockoutMessage(Number.POSITIVE_INFINITY)).toBe(
      'Too many attempts. Try again in a moment.'
    );
  });
});

describe('customUserMessage', () => {
  it('returns the input string unchanged', () => {
    const result = customUserMessage('Custom error message for the user.');
    expect(result).toBe('Custom error message for the user.');
  });

  it('preserves markdown in custom messages', () => {
    const result = customUserMessage('Please [sign up](/signup) to continue.');
    expect(result).toBe('Please [sign up](/signup) to continue.');
  });
});
