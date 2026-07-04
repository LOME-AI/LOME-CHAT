import { describe, expect, it } from 'vitest';
import { mediaTag, textTag } from '@hushbox/shared';
import { channelValueOf, contentValueOf, inputTagOf } from './channel-values.js';
import type { ContentValue, MediaValue } from '@hushbox/shared';

const MEDIA: MediaValue = {
  ref: 'media/c/m/u',
  mimeType: 'image/png',
  modality: 'image',
  byteLength: 4,
  metadata: {},
};

describe('channelValueOf', () => {
  it('unwraps a text content value to its string', () => {
    expect(channelValueOf({ kind: 'text', text: 'hi' })).toBe('hi');
  });

  it('unwraps a media content value to its media value', () => {
    expect(channelValueOf({ kind: 'media', value: MEDIA })).toEqual(MEDIA);
  });

  it('passes a bytes content value through unchanged', () => {
    const bytes: ContentValue = {
      kind: 'bytes',
      bytes: new Uint8Array(2),
      mimeType: 'image/png',
      modality: 'image',
    };
    expect(channelValueOf(bytes)).toBe(bytes);
  });
});

describe('inputTagOf', () => {
  it('tags a text input as text', () => {
    expect(inputTagOf({ kind: 'text', text: 'hi' })).toEqual(textTag());
  });

  it('tags a media input by its modality and mime type', () => {
    expect(inputTagOf({ kind: 'media', value: MEDIA })).toEqual(mediaTag('image', ['image/png']));
  });

  it('tags a bytes input by its modality and mime type', () => {
    expect(
      inputTagOf({
        kind: 'bytes',
        bytes: new Uint8Array(2),
        mimeType: 'image/png',
        modality: 'image',
      })
    ).toEqual(mediaTag('image', ['image/png']));
  });

  it('rejects a media ref claiming the text modality', () => {
    expect(
      inputTagOf({
        kind: 'media',
        value: { ...MEDIA, modality: 'text' },
      })
    ).toBeUndefined();
  });

  it('rejects a byte payload claiming the text modality', () => {
    expect(
      inputTagOf({
        kind: 'bytes',
        bytes: new Uint8Array(2),
        mimeType: 'text/plain',
        modality: 'text',
      })
    ).toBeUndefined();
  });
});

describe('contentValueOf', () => {
  it('wraps a string as a text content value', () => {
    expect(contentValueOf('hi')).toEqual({ kind: 'text', text: 'hi' });
  });

  it('wraps a media value as a media content value', () => {
    expect(contentValueOf(MEDIA)).toEqual({ kind: 'media', value: MEDIA });
  });

  it('passes an already-shaped content value through', () => {
    const text: ContentValue = { kind: 'text', text: 'hi' };
    expect(contentValueOf(text)).toEqual(text);
  });

  it('serializes structured json to a text content value', () => {
    expect(contentValueOf({ label: 'x' })).toEqual({ kind: 'text', text: '{"label":"x"}' });
  });

  it('serializes bigint json fields as decimal strings', () => {
    expect(contentValueOf({ n: 5n })).toEqual({ kind: 'text', text: '{"n":"5"}' });
  });
});
