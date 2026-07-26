import { describe, expect, it } from 'vitest';
import {
  ModelDescriptor,
  PricingSchema,
  callShapeFamilyFor,
  isRunnableModelShape,
} from './model-descriptor.js';
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
  releasedAt: 1_700_000_000,
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

describe('isRunnableModelShape', () => {
  const shape = (inputs: Modality[], outputs: Modality[]): ModelDescriptor =>
    ModelDescriptor.parse({ ...validDescriptor, inputs, outputs });

  it('accepts text-in text-out', () => {
    expect(isRunnableModelShape(shape(['text'], ['text']))).toBe(true);
  });

  it('accepts multimodal input (text plus image) with a single text output', () => {
    expect(isRunnableModelShape(shape(['text', 'image'], ['text']))).toBe(true);
  });

  it('accepts text-in single image output', () => {
    expect(isRunnableModelShape(shape(['text'], ['image']))).toBe(true);
  });

  it('accepts multimodal input with a single video output', () => {
    expect(isRunnableModelShape(shape(['text', 'image'], ['video']))).toBe(true);
  });

  it('rejects multi-output (image plus text)', () => {
    expect(isRunnableModelShape(shape(['text'], ['image', 'text']))).toBe(false);
  });

  it('rejects a model that does not accept text input', () => {
    expect(isRunnableModelShape(shape(['image'], ['image']))).toBe(false);
  });

  it('rejects audio output (no routable call-shape family)', () => {
    expect(isRunnableModelShape(shape(['text'], ['audio']))).toBe(false);
  });

  it('rejects embedding output', () => {
    expect(isRunnableModelShape(shape(['text'], ['embedding']))).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(isRunnableModelShape(shape([], ['text']))).toBe(false);
  });

  it('rejects empty outputs', () => {
    expect(isRunnableModelShape(shape(['text'], []))).toBe(false);
  });
});

describe('ModelDescriptor', () => {
  it('parses the descriptor shape', () => {
    const parsed = ModelDescriptor.parse(validDescriptor);
    expect(parsed.id).toBe('openai/gpt-5');
    expect(parsed.pricing).toEqual({ inputTokenPrice: 500n, outputTokenPrice: 1500n });
    expect(parsed.zdrReachable).toBe(true);
  });

  it('parses releasedAt as a unix-seconds release timestamp', () => {
    expect(ModelDescriptor.parse(validDescriptor).releasedAt).toBe(1_700_000_000);
  });

  it('parses an optional description (the classifier prompt line)', () => {
    const parsed = ModelDescriptor.parse({ ...validDescriptor, description: 'Fast and cheap.' });
    expect(parsed.description).toBe('Fast and cheap.');
  });

  it('leaves description absent when the source metadata carries none (never excludes)', () => {
    const parsed = ModelDescriptor.parse(validDescriptor);
    expect(parsed.description).toBeUndefined();
  });

  it('requires releasedAt (fail-closed: a model with no known release date is not exposed)', () => {
    const rest: Record<string, unknown> = { ...validDescriptor };
    delete rest['releasedAt'];
    expect(ModelDescriptor.safeParse(rest).success).toBe(false);
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

  it('accepts and preserves a zero popularityRank (most-used is rank 0)', () => {
    const parsed = ModelDescriptor.parse({ ...validDescriptor, popularityRank: 0 });
    expect(parsed.popularityRank).toBe(0);
  });

  it('accepts and preserves a positive popularityRank', () => {
    const parsed = ModelDescriptor.parse({ ...validDescriptor, popularityRank: 42 });
    expect(parsed.popularityRank).toBe(42);
  });

  it('leaves popularityRank undefined when absent (never materialized)', () => {
    expect(ModelDescriptor.parse(validDescriptor).popularityRank).toBeUndefined();
  });

  it('rejects a negative popularityRank', () => {
    expect(ModelDescriptor.safeParse({ ...validDescriptor, popularityRank: -1 }).success).toBe(
      false
    );
  });

  it('rejects a non-integer popularityRank', () => {
    expect(ModelDescriptor.safeParse({ ...validDescriptor, popularityRank: 1.5 }).success).toBe(
      false
    );
  });

  it('parses the optional structured reasoning field', () => {
    const parsed = ModelDescriptor.parse({
      ...validDescriptor,
      reasoning: {
        mandatory: true,
        supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'none'],
        defaultEffort: 'medium',
        defaultEnabled: true,
      },
    });
    expect(parsed.reasoning).toEqual({
      mandatory: true,
      supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'none'],
      defaultEffort: 'medium',
      defaultEnabled: true,
    });
  });

  it('preserves unknown effort strings raw (no enum narrowing at parse)', () => {
    const parsed = ModelDescriptor.parse({
      ...validDescriptor,
      reasoning: { supportedEfforts: ['ultra-think', 'max'] },
    });
    expect(parsed.reasoning?.supportedEfforts).toEqual(['ultra-think', 'max']);
  });

  it('preserves a null supportedEfforts (upstream: every effort accepted) distinct from absent', () => {
    const parsed = ModelDescriptor.parse({
      ...validDescriptor,
      reasoning: { mandatory: false, supportedEfforts: null },
    });
    expect(parsed.reasoning?.supportedEfforts).toBeNull();
  });

  it('parses a reasoning object with every sub-field absent (presence alone is signal)', () => {
    const parsed = ModelDescriptor.parse({ ...validDescriptor, reasoning: {} });
    expect(parsed.reasoning).toEqual({});
  });

  it('leaves reasoning absent when the source carries none (backward-compatible rows)', () => {
    const parsed = ModelDescriptor.parse(validDescriptor);
    expect(parsed.reasoning).toBeUndefined();
  });

  it('rejects non-string entries in supportedEfforts', () => {
    expect(
      ModelDescriptor.safeParse({ ...validDescriptor, reasoning: { supportedEfforts: [2] } })
        .success
    ).toBe(false);
  });
});
