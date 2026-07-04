import { describe, expect, it } from 'vitest';
import { stripPngMetadata } from './png-metadata.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Builds one chunk: <len BE4> <type ascii> <data> <crc4>. CRC is not validated. */
function chunk(type: string, data: readonly number[]): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...Array.from(type, (char) => char.codePointAt(0) ?? 0),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

const IHDR = chunk(
  'IHDR',
  Array.from({ length: 13 }, (_, index) => index)
);
const IDAT = chunk('IDAT', [0xaa, 0xbb]);
const IEND = chunk('IEND', []);

function png(...parts: readonly (readonly number[])[]): Uint8Array {
  return Uint8Array.from([SIGNATURE, ...parts].flat());
}

/** Assembles parts with set() — argument-spreading megabyte regions throws. */
function bytesOf(...parts: readonly (readonly number[] | Uint8Array)[]): Uint8Array {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)));
  const out = new Uint8Array(arrays.reduce((total, array) => total + array.length, 0));
  let cursor = 0;
  for (const array of arrays) {
    out.set(array, cursor);
    cursor += array.length;
  }
  return out;
}

describe('stripPngMetadata', () => {
  it.each(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])('removes %s chunks', (type) => {
    const input = png(IHDR, chunk(type, [1, 2, 3]), IDAT, IEND);
    const stripped = stripPngMetadata(input)._unsafeUnwrap();
    expect([...stripped]).toEqual([...png(IHDR, IDAT, IEND)]);
  });

  it('keeps the chunks the decoder needs', () => {
    const input = png(IHDR, chunk('PLTE', [9, 9, 9]), IDAT, IEND);
    const stripped = stripPngMetadata(input)._unsafeUnwrap();
    expect([...stripped]).toEqual([...input]);
  });

  it('strips metadata from a PNG with a multi-megabyte IDAT chunk', () => {
    const dataLength = 3 * 1024 * 1024;
    const bigIdat = new Uint8Array(8 + dataLength + 4);
    new DataView(bigIdat.buffer).setUint32(0, dataLength);
    bigIdat.set(
      Array.from('IDAT', (char) => char.codePointAt(0) ?? 0),
      4
    );
    bigIdat.fill(0xab, 8, 8 + dataLength);
    const input = bytesOf(SIGNATURE, IHDR, chunk('tEXt', [1, 2, 3]), bigIdat, IEND);
    const stripped = stripPngMetadata(input)._unsafeUnwrap();
    const expected = bytesOf(SIGNATURE, IHDR, bigIdat, IEND);
    expect(stripped.length).toBe(expected.length);
    expect(stripped.every((byte, index) => byte === expected[index])).toBe(true);
  });

  it('rejects a stream without the PNG signature', () => {
    const result = stripPngMetadata(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a truncated chunk header', () => {
    const truncated = png(IHDR).slice(0, SIGNATURE.length + 4);
    const result = stripPngMetadata(Uint8Array.from(truncated));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a truncated chunk', () => {
    const truncated = png(IHDR).slice(0, SIGNATURE.length + 10);
    const result = stripPngMetadata(Uint8Array.from(truncated));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a stream that ends without an IEND chunk', () => {
    const result = stripPngMetadata(png(IHDR, IDAT));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});
