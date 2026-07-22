import { describe, expect, it } from 'vitest';
import { assertValidMediaBytes } from './media-assertions.js';

/** Pad a leading signature out to `length` bytes so the detector's 12-byte floor is met. */
function withSignature(signature: readonly number[], length: number, offset = 0): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(signature, offset);
  return bytes;
}

const PNG = withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 64);
const JPEG = withSignature([0xff, 0xd8, 0xff], 64);
const MP4 = withSignature([0x66, 0x74, 0x79, 0x70], 64, 4); // `ftyp` at offset 4
const WEBM = withSignature([0x1a, 0x45, 0xdf, 0xa3], 64);

/** WebP: `RIFF` at offset 0 and `WEBP` at offset 8. */
function webpBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  return bytes;
}

const IMAGE_BOUNDS = { min: 32, max: 10_000_000 } as const;
const VIDEO_BOUNDS = { min: 16, max: 50_000_000 } as const;

describe('assertValidMediaBytes', () => {
  it('detects a PNG signature', () => {
    expect(
      assertValidMediaBytes(PNG, ['image/png', 'image/jpeg', 'image/webp'], IMAGE_BOUNDS)
    ).toEqual({ detectedMime: 'image/png' });
  });

  it('detects a JPEG signature', () => {
    expect(
      assertValidMediaBytes(JPEG, ['image/png', 'image/jpeg', 'image/webp'], IMAGE_BOUNDS)
    ).toEqual({ detectedMime: 'image/jpeg' });
  });

  it('detects a WebP signature (RIFF + WEBP at offset 8)', () => {
    expect(
      assertValidMediaBytes(webpBytes(), ['image/png', 'image/jpeg', 'image/webp'], IMAGE_BOUNDS)
    ).toEqual({ detectedMime: 'image/webp' });
  });

  it('detects an MP4 ftyp box (offset 4)', () => {
    expect(assertValidMediaBytes(MP4, ['video/mp4', 'video/webm'], VIDEO_BOUNDS)).toEqual({
      detectedMime: 'video/mp4',
    });
  });

  it('detects a WebM EBML signature', () => {
    expect(assertValidMediaBytes(WEBM, ['video/mp4', 'video/webm'], VIDEO_BOUNDS)).toEqual({
      detectedMime: 'video/webm',
    });
  });

  it('throws when the byte length is below the minimum bound', () => {
    expect(() => assertValidMediaBytes(PNG, ['image/png'], { min: 128, max: 10_000_000 })).toThrow(
      /too small/
    );
  });

  it('throws when the byte length is above the maximum bound', () => {
    expect(() => assertValidMediaBytes(PNG, ['image/png'], { min: 32, max: 40 })).toThrow(
      /too large/
    );
  });

  it('throws when no known signature matches', () => {
    const unknown = new Uint8Array(64); // all zeros — no signature
    expect(() => assertValidMediaBytes(unknown, ['image/png'], IMAGE_BOUNDS)).toThrow(
      /detect media format/
    );
  });

  it('throws when the detected mime is not in the allowed list', () => {
    expect(() => assertValidMediaBytes(PNG, ['image/jpeg'], IMAGE_BOUNDS)).toThrow(
      /not in allowed list/
    );
  });

  it('reports undetectable for a buffer shorter than the 12-byte floor', () => {
    const tiny = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(() => assertValidMediaBytes(tiny, ['image/png'], { min: 1, max: 100 })).toThrow(
      /detect media format/
    );
  });
});
