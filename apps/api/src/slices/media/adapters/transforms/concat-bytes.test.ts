import { describe, expect, it } from 'vitest';
import { concatBytes } from './concat-bytes.js';

describe('concatBytes', () => {
  it('assembles parts in order into one buffer', () => {
    const out = concatBytes([Uint8Array.from([1, 2]), Uint8Array.from([]), Uint8Array.from([3])]);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it('returns an empty buffer for no parts', () => {
    expect(concatBytes([]).length).toBe(0);
  });

  it('assembles a multi-megabyte part without throwing', () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(0xcd);
    const out = concatBytes([Uint8Array.from([0xff]), big]);
    expect(out.length).toBe(big.length + 1);
    expect(out[0]).toBe(0xff);
    expect(out.at(-1)).toBe(0xcd);
  });
});
