import { describe, expect, it } from 'vitest';
import { normalizeModel } from './normalize.js';
import type { GatewayModelMetadata } from './gateway-metadata.js';
import type { ModelOverride } from './overrides.js';

function languageModel(overrides: Partial<GatewayModelMetadata> = {}): GatewayModelMetadata {
  return {
    id: 'openai/gpt-test',
    provider: 'openai',
    modelType: 'language',
    pricing: { input: '0.0000025', output: '0.00001' },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportedParameters: ['temperature', 'top_p', 'max_output_tokens', 'tools', 'reasoning'],
    contextLength: 128_000,
    endpointProviders: ['openai'],
    ...overrides,
  };
}

const ZDR_PROVIDERS: ReadonlySet<string> = new Set(['openai']);

function override(data: ModelOverride['data'], zdrVerifiedAt: Date | null = null): ModelOverride {
  return { modelId: 'any', data, zdrVerifiedAt };
}

describe('normalizeModel', () => {
  it('normalizes a language model into descriptor content', () => {
    const outcome = normalizeModel(languageModel(), ZDR_PROVIDERS);
    expect(outcome).toMatchObject({
      kind: 'normalized',
      family: 'language',
      content: {
        id: 'openai/gpt-test',
        provider: 'openai',
        inputs: ['text', 'image'],
        outputs: ['text'],
        behaviors: ['streaming', 'tools', 'reasoning'],
        limits: { contextLength: 128_000 },
        pricing: { inputPerToken: '2500', outputPerToken: '10000' },
        zdrReachable: true,
      },
    });
  });

  it('seeds parameter specs from gateway supported parameter names', () => {
    const outcome = normalizeModel(languageModel(), ZDR_PROVIDERS);
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.parameters['temperature']).toMatchObject({
      type: 'number',
      wire: 'firstClass',
    });
    expect(outcome.content.parameters['topP']).toMatchObject({ type: 'number' });
    expect(outcome.content.parameters['maxOutputTokens']).toMatchObject({ type: 'integer' });
  });

  it('skips gateway parameter names without a known spec', () => {
    const outcome = normalizeModel(
      languageModel({ supportedParameters: ['temperature', 'mystery_knob'] }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(Object.keys(outcome.content.parameters)).toEqual(['temperature']);
  });

  it('excludes a model whose gateway type has no call-shape family', () => {
    const outcome = normalizeModel(languageModel({ modelType: 'reranking' }), ZDR_PROVIDERS);
    expect(outcome).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      modelType: 'reranking',
    });
  });

  it('treats a missing model type as language', () => {
    const outcome = normalizeModel(languageModel({ modelType: undefined }), ZDR_PROVIDERS);
    expect(outcome).toMatchObject({ kind: 'normalized', family: 'language' });
  });

  it('marks a model unreachable when no serving provider is on the ZDR list', () => {
    const outcome = normalizeModel(
      languageModel({ endpointProviders: ['shadow-cloud'] }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.zdrReachable).toBe(false);
  });

  it('marks a model unreachable when the ZDR provider list is empty', () => {
    const outcome = normalizeModel(languageModel(), new Set<string>());
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.zdrReachable).toBe(false);
  });

  it('honors a documented model-level ZDR exclusion override', () => {
    const outcome = normalizeModel(languageModel(), ZDR_PROVIDERS, override({ zdrExcluded: true }));
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.zdrReachable).toBe(false);
  });

  it('filters architecture modalities outside the closed enum', () => {
    const outcome = normalizeModel(
      languageModel({ inputModalities: ['text', 'smell'], outputModalities: ['text'] }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.inputs).toEqual(['text']);
  });

  it('defaults empty architecture modalities to text for the language family', () => {
    const outcome = normalizeModel(
      languageModel({ inputModalities: [], outputModalities: [] }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.inputs).toEqual(['text']);
    expect(outcome.content.outputs).toEqual(['text']);
  });

  it('assigns no language behaviors to a language-typed model with media-only outputs', () => {
    const outcome = normalizeModel(
      languageModel({ outputModalities: ['image', 'video'] }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.behaviors).toEqual([]);
  });

  it('pins an image model to image output regardless of architecture', () => {
    const outcome = normalizeModel(
      languageModel({ modelType: 'image', outputModalities: [], pricing: undefined }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.family).toBe('image');
    expect(outcome.content.outputs).toEqual(['image']);
    expect(outcome.content.behaviors).toEqual([]);
  });

  it('pins a video model to video output regardless of architecture', () => {
    const outcome = normalizeModel(
      languageModel({ modelType: 'video', outputModalities: ['text'], pricing: undefined }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.family).toBe('video');
    expect(outcome.content.outputs).toEqual(['video']);
  });

  it('pins an embedding model to embedding output regardless of architecture', () => {
    const outcome = normalizeModel(
      languageModel({ modelType: 'embedding', outputModalities: ['text'] }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.family).toBe('embedding');
    expect(outcome.content.outputs).toEqual(['embedding']);
  });

  it('leaves pricing empty when the gateway reports none', () => {
    const outcome = normalizeModel(languageModel({ pricing: undefined }), ZDR_PROVIDERS);
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.pricing).toEqual({});
  });

  it('omits rates the gateway leaves out of a partial pricing object', () => {
    const outcome = normalizeModel(
      languageModel({ pricing: { output: '0.00001' } }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.pricing).toEqual({ outputPerToken: '10000' });
  });

  it('guards the off-contract shape where pricing carries no output rate', () => {
    const outcome = normalizeModel(
      languageModel({ pricing: { input: '0.0000025' } }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.pricing).toEqual({ inputPerToken: '2500' });
  });

  it('omits a gateway rate that cannot be represented in nano-USD', () => {
    const outcome = normalizeModel(
      languageModel({ pricing: { input: 'mystery', output: '0.00001' } }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.pricing).toEqual({ outputPerToken: '10000' });
  });

  it('includes the cached-input rate when the gateway reports one', () => {
    const outcome = normalizeModel(
      languageModel({
        pricing: { input: '0.000002', output: '0.00001', cachedInputTokens: '0.000001' },
      }),
      ZDR_PROVIDERS
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.pricing['cachedInputPerToken']).toBe('1000');
  });

  it('merges override pricing over gateway-derived pricing', () => {
    const outcome = normalizeModel(
      languageModel(),
      ZDR_PROVIDERS,
      override({ pricing: { inputPerToken: '9999', perImage: '40000000' } })
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.pricing).toEqual({
      inputPerToken: '9999',
      outputPerToken: '10000',
      perImage: '40000000',
    });
  });

  it('merges override parameter specs over seeded specs', () => {
    const outcome = normalizeModel(
      languageModel({ supportedParameters: ['temperature'] }),
      ZDR_PROVIDERS,
      override({ parameters: { size: { type: 'enum', values: ['1024x1024'] } } })
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(Object.keys(outcome.content.parameters).toSorted(byName)).toEqual([
      'size',
      'temperature',
    ]);
  });

  it('omits limits when the gateway reports no context length', () => {
    const outcome = normalizeModel(languageModel({ contextLength: undefined }), ZDR_PROVIDERS);
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    expect(outcome.content.limits).toEqual({});
  });
});
