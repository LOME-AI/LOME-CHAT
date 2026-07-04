import { describe, expect, it } from 'vitest';
import { stripImageMetadataEntry } from './strip-image-metadata.js';
import type { ContentValue } from '@hushbox/shared';

const MINIMAL_JPEG = Uint8Array.from([
  0xff,
  0xd8, // SOI
  0xff,
  0xe1,
  0x00,
  0x04,
  0x11,
  0x22, // APP1 (metadata)
  0xff,
  0xda,
  0x00,
  0x02, // SOS
  0xff,
  0xd9, // EOI
]);

const MINIMAL_PNG = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x01,
  0x74,
  0x45,
  0x58,
  0x74,
  0x41,
  0x00,
  0x00,
  0x00,
  0x00, // tEXt "A"
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0x00,
  0x00,
  0x00,
  0x00, // IEND
]);

function imageBytes(bytes: Uint8Array<ArrayBuffer>, mimeType: string): ContentValue {
  return { kind: 'bytes', bytes, mimeType, modality: 'image' };
}

describe('strip-image-metadata entry', () => {
  it('declares its registry identity', () => {
    expect(stripImageMetadataEntry.name).toBe('strip-image-metadata');
    expect(stripImageMetadataEntry.version).toBe(1);
  });

  it('declares one image input covering both handled formats', () => {
    expect(stripImageMetadataEntry.ports).toEqual({
      in: [{ kind: 'media', modality: 'image', mimeTypes: ['image/jpeg', 'image/png'] }],
      out: { kind: 'media', modality: 'image', mimeTypes: ['image/jpeg', 'image/png'] },
    });
  });

  it('strips a JPEG input, preserving its mime type', () => {
    const output = stripImageMetadataEntry
      .run([imageBytes(MINIMAL_JPEG, 'image/jpeg')])
      ._unsafeUnwrap();
    expect(output.kind).toBe('bytes');
    if (output.kind === 'bytes') {
      expect(output.mimeType).toBe('image/jpeg');
      expect(output.bytes.length).toBeLessThan(MINIMAL_JPEG.length);
    }
  });

  it('strips a PNG input, preserving its mime type', () => {
    const output = stripImageMetadataEntry
      .run([imageBytes(MINIMAL_PNG, 'image/png')])
      ._unsafeUnwrap();
    expect(output.kind).toBe('bytes');
    if (output.kind === 'bytes') {
      expect(output.mimeType).toBe('image/png');
      expect(output.bytes.length).toBeLessThan(MINIMAL_PNG.length);
    }
  });

  it('rejects a text input', () => {
    const result = stripImageMetadataEntry.run([{ kind: 'text', text: 'hello' }]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a media reference input that was never materialized', () => {
    const result = stripImageMetadataEntry.run([
      {
        kind: 'media',
        value: {
          ref: 'media/x/y/z',
          mimeType: 'image/jpeg',
          modality: 'image',
          byteLength: 3,
          metadata: {},
        },
      },
    ]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a mime type outside the declared set', () => {
    const result = stripImageMetadataEntry.run([imageBytes(MINIMAL_JPEG, 'image/gif')]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects the wrong input arity', () => {
    const input = imageBytes(MINIMAL_JPEG, 'image/jpeg');
    expect(stripImageMetadataEntry.run([])._unsafeUnwrapErr().code).toBe('validation');
    expect(stripImageMetadataEntry.run([input, input])._unsafeUnwrapErr().code).toBe('validation');
  });
});
