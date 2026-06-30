import { describe, expect, it } from 'vitest';
import { ModelDescriptor, PricingSchema, callShapeFamilyFor } from './model-descriptor.js';
import type { CallShapeFamily } from './model-descriptor.js';
import type { Modality } from './modality.js';

const validDescriptor = {
  id: 'openai/gpt-5',
  provider: 'openai',
  version: '2026-06-01',
  inputs: ['text', 'image'],
  outputs: ['text'],
  parameters: {
    temperature: { type: 'number', min: 0, max: 2 },
  },
  behaviors: ['streaming', 'tools'],
  limits: { contextTokens: 400_000 },
  pricing: { inputTokenPrice: '500', outputTokenPrice: '1500' },
  zdrReachable: true,
  fetchedAt: 1_780_000_000_000,
};

describe('PricingSchema', () => {
  it('parses flat nano-USD string rates into bigints', () => {
    expect(PricingSchema.parse({ inputTokenPrice: '500' })).toEqual({ inputTokenPrice: 500n });
  });

  it('parses one nested level (per-size/per-resolution matrices)', () => {
    expect(PricingSchema.parse({ perSecondByResolution: { '720p': '4000000' } })).toEqual({
      perSecondByResolution: { '720p': 4_000_000n },
    });
  });

  it('rejects number rates (money is never a JSON number)', () => {
    expect(PricingSchema.safeParse({ inputTokenPrice: 500 }).success).toBe(false);
  });
});

describe('callShapeFamilyFor', () => {
  const table: readonly [readonly Modality[], CallShapeFamily | undefined][] = [
    [['text'], 'language'],
    [['text', 'image'], 'language'],
    [['text', 'video'], 'language'],
    [['text', 'image', 'video'], 'language'],
    [['embedding'], 'embedding'],
    [['embedding', 'image'], 'embedding'],
    [['embedding', 'video'], 'embedding'],
    [['image'], 'image'],
    [['image', 'video'], 'image'],
    [['video'], 'video'],
    [['video', 'audio'], 'video'],
    [['audio'], undefined],
    [[], undefined],
  ];

  it.each(table)('classifies outputs %j as %s', (outputs, family) => {
    expect(callShapeFamilyFor(outputs)).toBe(family);
  });

  it('media-classifies an image+video descriptor so the media ZDR exposure gate applies', () => {
    // The dangerous shape: no text output, two media outputs. Classifying it
    // language would skip the dated-ZDR media gate while the adapter routes
    // it to the image call-shape — the divergence this function exists to
    // make impossible.
    expect(callShapeFamilyFor(['image', 'video'])).toBe('image');
  });

  it('classifies text+embedding as language (text wins over embedding)', () => {
    expect(callShapeFamilyFor(['text', 'embedding'])).toBe('language');
  });

  it('returns undefined for audio-only outputs (no call-shape exists yet)', () => {
    expect(callShapeFamilyFor(['audio'])).toBeUndefined();
  });
});

describe('ModelDescriptor', () => {
  it('parses the descriptor shape', () => {
    const parsed = ModelDescriptor.parse(validDescriptor);
    expect(parsed.id).toBe('openai/gpt-5');
    expect(parsed.pricing).toEqual({ inputTokenPrice: 500n, outputTokenPrice: 1500n });
    expect(parsed.zdrReachable).toBe(true);
  });

  it('rejects an unknown modality in inputs', () => {
    expect(ModelDescriptor.safeParse({ ...validDescriptor, inputs: ['speech'] }).success).toBe(
      false
    );
  });

  it('rejects an invalid nested ParamSpec', () => {
    expect(
      ModelDescriptor.safeParse({
        ...validDescriptor,
        parameters: { temperature: { type: 'object' } },
      }).success
    ).toBe(false);
  });

  it('requires zdrReachable (fail-closed ZDR is a required fact, not a default)', () => {
    // eslint-disable-next-line sonarjs/no-unused-vars -- rest-spread requires naming the omitted key
    const { zdrReachable: _zdr, ...rest } = validDescriptor;
    expect(ModelDescriptor.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-numeric limits value', () => {
    expect(
      ModelDescriptor.safeParse({ ...validDescriptor, limits: { contextTokens: 'big' } }).success
    ).toBe(false);
  });
});
