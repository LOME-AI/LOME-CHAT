import { describe, it, expect } from 'vitest';

import { pgErrorCode, requireString } from './txn-executor';

describe('pgErrorCode', () => {
  it('returns the code on the error itself', () => {
    const error = Object.assign(new Error('locked'), { code: '55P03' });
    expect(pgErrorCode(error)).toBe('55P03');
  });

  it('walks the cause chain to find a code', () => {
    const cause = Object.assign(new Error('locked'), { code: '55P03' });
    const wrapped = new Error('query failed', { cause });
    expect(pgErrorCode(wrapped)).toBe('55P03');
  });

  it('returns unknown when no code is present anywhere in the chain', () => {
    expect(pgErrorCode(new Error('plain'))).toBe('unknown');
  });
});

describe('requireString', () => {
  it('returns the string value of the column', () => {
    expect(requireString({ value: 'hello' }, 'value')).toBe('hello');
  });

  it('throws when the row is missing', () => {
    expect(() => requireString(undefined, 'value')).toThrow(/value/);
  });

  it('throws when the column value is not a string', () => {
    expect(() => requireString({ value: 42 }, 'value')).toThrow(/value/);
  });
});
