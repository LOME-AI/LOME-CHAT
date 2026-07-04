import { describe, expect, it } from 'vitest';
import { stripJpegMetadata } from './jpeg-metadata.js';

/** Builds one marker segment: FF <marker> <len BE> <payload>. */
function segment(marker: number, payload: readonly number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const JFIF = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00]);
const EXIF = segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x11, 0x22]);
const IPTC = segment(0xed, [0x50, 0x68, 0x6f, 0x74, 0x6f]);
const COMMENT = segment(0xfe, [0x68, 0x69]);
const ADOBE = segment(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65]);
const QUANT = segment(0xdb, [0x00, 0x01, 0x02]);
// SOS carries a parameter payload, then entropy-coded data runs to EOI.
const SOS = segment(0xda, [0x01, 0x00]);
const ENTROPY = [0x12, 0xff, 0x00, 0x34];

function jpeg(...parts: readonly (readonly number[])[]): Uint8Array {
  return Uint8Array.from(parts.flat());
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

describe('stripJpegMetadata', () => {
  it('removes the Exif APP1 segment', () => {
    const stripped = stripJpegMetadata(jpeg(SOI, JFIF, EXIF, SOS, ENTROPY, EOI))._unsafeUnwrap();
    expect([...stripped]).toEqual([...jpeg(SOI, JFIF, SOS, ENTROPY, EOI)]);
  });

  it('removes the IPTC APP13 segment', () => {
    const stripped = stripJpegMetadata(jpeg(SOI, IPTC, SOS, ENTROPY, EOI))._unsafeUnwrap();
    expect([...stripped]).toEqual([...jpeg(SOI, SOS, ENTROPY, EOI)]);
  });

  it('removes comment segments', () => {
    const stripped = stripJpegMetadata(jpeg(SOI, COMMENT, SOS, ENTROPY, EOI))._unsafeUnwrap();
    expect([...stripped]).toEqual([...jpeg(SOI, SOS, ENTROPY, EOI)]);
  });

  it('keeps segments the decoder needs', () => {
    const input = jpeg(SOI, JFIF, ADOBE, QUANT, SOS, ENTROPY, EOI);
    const stripped = stripJpegMetadata(input)._unsafeUnwrap();
    expect([...stripped]).toEqual([...input]);
  });

  it('copies the entropy-coded stream after SOS verbatim', () => {
    const entropyWithMarkers = [0xff, 0xd0, 0xff, 0x00, 0xab];
    const input = jpeg(SOI, SOS, entropyWithMarkers, EOI);
    const stripped = stripJpegMetadata(input)._unsafeUnwrap();
    expect([...stripped]).toEqual([...input]);
  });

  it('preserves a stream whose header ends directly at EOI', () => {
    const input = jpeg(SOI, JFIF, EOI);
    const stripped = stripJpegMetadata(input)._unsafeUnwrap();
    expect([...stripped]).toEqual([...input]);
  });

  it('strips metadata from a JPEG with a multi-megabyte entropy-coded stream', () => {
    const entropy = new Uint8Array(3 * 1024 * 1024).fill(0xab);
    const input = bytesOf(SOI, JFIF, EXIF, SOS, entropy, EOI);
    const stripped = stripJpegMetadata(input)._unsafeUnwrap();
    const expected = bytesOf(SOI, JFIF, SOS, entropy, EOI);
    expect(stripped.length).toBe(expected.length);
    expect(stripped.every((byte, index) => byte === expected[index])).toBe(true);
  });

  it('drops bytes appended after the EOI marker', () => {
    const trailer = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70];
    const stripped = stripJpegMetadata(jpeg(SOI, SOS, ENTROPY, EOI, trailer))._unsafeUnwrap();
    expect([...stripped]).toEqual([...jpeg(SOI, SOS, ENTROPY, EOI)]);
  });

  it('rejects an entropy-coded stream that ends without EOI', () => {
    const result = stripJpegMetadata(jpeg(SOI, SOS, ENTROPY));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('skips 0xFF fill bytes preceding a marker', () => {
    const stripped = stripJpegMetadata(
      jpeg(SOI, [0xff, 0xff], JFIF, SOS, ENTROPY, EOI)
    )._unsafeUnwrap();
    expect([...stripped]).toEqual([...jpeg(SOI, JFIF, SOS, ENTROPY, EOI)]);
  });

  it('rejects a stream without the JPEG start marker', () => {
    const result = stripJpegMetadata(Uint8Array.from([0x00, 0x01, 0x02]));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a truncated segment', () => {
    const truncated = jpeg(SOI, EXIF).slice(0, 6);
    const result = stripJpegMetadata(Uint8Array.from(truncated));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a segment cut inside its length field', () => {
    const truncated = jpeg(SOI, EXIF).slice(0, 5);
    const result = stripJpegMetadata(Uint8Array.from(truncated));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a byte where a marker prefix is expected', () => {
    const result = stripJpegMetadata(jpeg(SOI, [0x00, 0xe1]));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a stream that ends immediately after a marker prefix', () => {
    const result = stripJpegMetadata(jpeg(SOI, [0xff]));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a header section that ends without EOI', () => {
    const result = stripJpegMetadata(jpeg(SOI, JFIF));
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});
