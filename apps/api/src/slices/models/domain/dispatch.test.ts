import { describe, expect, it } from 'vitest';
import { dispatchFamilyFor, familyForModelType } from './dispatch.js';
import type { ModelDescriptor } from '@hushbox/shared';

function descriptorWith(outputs: ModelDescriptor['outputs']): ModelDescriptor {
  return {
    id: 'test/model',
    provider: 'test',
    version: '1',
    inputs: ['text'],
    outputs,
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    fetchedAt: 0,
  };
}

describe('familyForModelType', () => {
  it('maps the language gateway type to the language family', () => {
    expect(familyForModelType('language')).toBe('language');
  });

  it('maps the image gateway type to the image family', () => {
    expect(familyForModelType('image')).toBe('image');
  });

  it('maps the video gateway type to the video family', () => {
    expect(familyForModelType('video')).toBe('video');
  });

  it('maps the embedding gateway type to the embedding family', () => {
    expect(familyForModelType('embedding')).toBe('embedding');
  });

  it('defaults a missing model type to language', () => {
    expect(familyForModelType()).toBe('language');
  });

  it('returns undefined for a gateway type outside the family set', () => {
    expect(familyForModelType('reranking')).toBeUndefined();
  });
});

describe('dispatchFamilyFor', () => {
  it('classifies an embedding-output descriptor as embedding', () => {
    expect(dispatchFamilyFor(descriptorWith(['embedding']))).toBe('embedding');
  });

  it('classifies an image-only descriptor as image', () => {
    expect(dispatchFamilyFor(descriptorWith(['image']))).toBe('image');
  });

  it('classifies a video-only descriptor as video', () => {
    expect(dispatchFamilyFor(descriptorWith(['video']))).toBe('video');
  });

  it('classifies a text-output descriptor as language', () => {
    expect(dispatchFamilyFor(descriptorWith(['text']))).toBe('language');
  });

  it('classifies a multi-output descriptor with text as language', () => {
    expect(dispatchFamilyFor(descriptorWith(['text', 'image']))).toBe('language');
  });

  it('media-classifies an image+video descriptor as image (canonical derivation)', () => {
    // Classified language, this shape would skip the media ZDR exposure
    // gate while the adapter routes it to the image call-shape.
    expect(dispatchFamilyFor(descriptorWith(['image', 'video']))).toBe('image');
  });

  it('returns undefined for an audio-only descriptor (excluded with alert by callers)', () => {
    expect(dispatchFamilyFor(descriptorWith(['audio']))).toBeUndefined();
  });
});
