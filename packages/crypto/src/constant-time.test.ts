import { describe, it, expect } from 'vitest';
import { constantTimeCompare } from './constant-time.js';

describe('constantTimeCompare', () => {
  it('returns true for equal arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeCompare(a, b)).toBe(true);
  });

  it('returns false for different arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  it('returns false for different lengths', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  it('returns true for empty arrays', () => {
    const a = new Uint8Array([]);
    const b = new Uint8Array([]);
    expect(constantTimeCompare(a, b)).toBe(true);
  });

  it('returns false when first byte differs', () => {
    const a = new Uint8Array([0, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  it('returns false when last byte differs', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 0]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  it('returns false when middle byte differs', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 0, 3, 4]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  // Characterization (off-contract input): the byte-lookup fallback treats an
  // absent index as 0x00. A real Uint8Array can never hold undefined and the
  // length guard keeps every index in range, so this is reachable only by
  // passing a plain-array impostor as the second argument.
  it('treats absent bytes in an array-like with undefined entries as zero', () => {
    const a = new Uint8Array(2);
    const sparse = Array.from({ length: 2 }) as unknown as Uint8Array;
    expect(constantTimeCompare(a, sparse)).toBe(true);
  });
});
