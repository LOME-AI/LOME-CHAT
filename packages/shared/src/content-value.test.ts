import { describe, expect, it } from 'vitest';
import { ContentValue, MediaValue } from './content-value.js';

const validMedia = {
  ref: 'media/conv-1/msg-1/0197a000-0000-7000-8000-000000000000',
  mimeType: 'image/png',
  modality: 'image',
  byteLength: 2048,
  metadata: { width: 512 },
};

describe('MediaValue', () => {
  it('parses the media value shape', () => {
    expect(MediaValue.parse(validMedia)).toEqual(validMedia);
  });

  it('rejects a missing ref', () => {
    // eslint-disable-next-line sonarjs/no-unused-vars -- rest-spread requires naming the omitted key
    const { ref: _ref, ...rest } = validMedia;
    expect(MediaValue.safeParse(rest).success).toBe(false);
  });

  it('rejects an unknown modality', () => {
    expect(MediaValue.safeParse({ ...validMedia, modality: 'speech' }).success).toBe(false);
  });

  it('rejects a negative byteLength', () => {
    expect(MediaValue.safeParse({ ...validMedia, byteLength: -1 }).success).toBe(false);
  });
});

describe('ContentValue', () => {
  it('parses inline text', () => {
    expect(ContentValue.parse({ kind: 'text', text: 'hello' })).toEqual({
      kind: 'text',
      text: 'hello',
    });
  });

  it('parses inline bytes', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const parsed = ContentValue.parse({
      kind: 'bytes',
      bytes,
      mimeType: 'image/png',
      modality: 'image',
    });
    expect(parsed).toEqual({ kind: 'bytes', bytes, mimeType: 'image/png', modality: 'image' });
  });

  it('parses a media ref', () => {
    expect(ContentValue.parse({ kind: 'media', value: validMedia })).toEqual({
      kind: 'media',
      value: validMedia,
    });
  });

  it('rejects an unknown kind', () => {
    expect(ContentValue.safeParse({ kind: 'blob', data: 'x' }).success).toBe(false);
  });

  it('rejects inline bytes that are not a Uint8Array', () => {
    expect(
      ContentValue.safeParse({
        kind: 'bytes',
        bytes: [1, 2, 3],
        mimeType: 'image/png',
        modality: 'image',
      }).success
    ).toBe(false);
  });
});
