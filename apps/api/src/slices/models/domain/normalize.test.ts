import { describe, expect, it } from 'vitest';
import { ModelDescriptor } from '@hushbox/shared';
import { normalizeCatalog, normalizeModel } from './normalize.js';
import type { ImageMetadata, LanguageMetadata, VideoMetadata } from './gateway-metadata.js';
import type { CatalogEntry, DescriptorContent } from './normalize.js';

function languageModel(overrides: Partial<LanguageMetadata> = {}): LanguageMetadata {
  return {
    source: 'language',
    id: 'openai/gpt-test',
    provider: 'openai',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportedParameters: ['temperature', 'top_p', 'max_output_tokens', 'tools', 'reasoning'],
    contextLength: 128_000,
    pricing: { prompt: '0.0000025', completion: '0.00001' },
    releasedAt: 1_700_000_000,
    deprecated: false,
    ...overrides,
  };
}

function imageModel(overrides: Partial<ImageMetadata> = {}): ImageMetadata {
  return {
    source: 'image',
    id: 'google/test-image',
    provider: 'google',
    inputModalities: ['text'],
    supportedParameters: { resolution: ['1024x1024'], aspectRatio: ['1:1'], maxN: 4 },
    endpointPricing: [{ billable: 'output_image', unit: 'image', costUsd: '0.04' }],
    releasedAt: 1_700_000_000,
    ...overrides,
  };
}

function videoModel(overrides: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    source: 'video',
    id: 'google/test-video',
    provider: 'google',
    supportsFrameImages: false,
    generateAudio: true,
    seed: true,
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9'],
    durations: ['4', '8'],
    pricingSkus: { duration_seconds_720p: '0.0988' },
    releasedAt: 1_700_000_000,
    ...overrides,
  };
}

const ZDR: ReadonlySet<string> = new Set([
  'openai/gpt-test',
  'google/test-image',
  'google/test-video',
]);

function normalized(outcome: ReturnType<typeof normalizeModel>): DescriptorContent {
  if (outcome.kind !== 'normalized') throw new Error(`expected normalized, got ${outcome.kind}`);
  return outcome.content;
}

describe('normalizeModel (language)', () => {
  it('normalizes a language model into descriptor content', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR))).toMatchObject({
      id: 'openai/gpt-test',
      provider: 'openai',
      inputs: ['text', 'image'],
      outputs: ['text'],
      behaviors: ['streaming', 'tools', 'reasoning'],
      limits: { contextLength: 128_000 },
      pricing: { inputPerToken: '2500', outputPerToken: '10000' },
      zdrReachable: true,
    });
  });

  it('seeds parameter specs from supported parameter names', () => {
    const content = normalized(normalizeModel(languageModel(), ZDR));
    expect(content.parameters['temperature']).toMatchObject({ type: 'number', wire: 'firstClass' });
    expect(content.parameters['topP']).toMatchObject({ type: 'number' });
    expect(content.parameters['maxOutputTokens']).toMatchObject({ type: 'integer' });
  });

  it('skips supported parameter names without a known spec', () => {
    const content = normalized(
      normalizeModel(languageModel({ supportedParameters: ['temperature', 'mystery_knob'] }), ZDR)
    );
    expect(Object.keys(content.parameters)).toEqual(['temperature']);
  });

  it('excludes a model whose output modalities classify to no family', () => {
    expect(normalizeModel(languageModel({ outputModalities: ['smell'] }), ZDR)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'unclassifiable-modality',
    });
  });

  it('excludes a model with empty output modalities', () => {
    expect(normalizeModel(languageModel({ outputModalities: [] }), ZDR)).toMatchObject({
      kind: 'excluded',
      reason: 'unclassifiable-modality',
    });
  });

  it('excludes a deprecated model', () => {
    expect(normalizeModel(languageModel({ deprecated: true }), ZDR)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'deprecated',
    });
  });

  it('carries the source description into descriptor content for every family', () => {
    expect(
      normalized(normalizeModel(languageModel({ description: 'Fast frontier model.' }), ZDR))
        .description
    ).toBe('Fast frontier model.');
    expect(
      normalized(normalizeModel(imageModel({ description: 'Draws pictures.' }), ZDR)).description
    ).toBe('Draws pictures.');
    expect(
      normalized(normalizeModel(videoModel({ description: 'Makes movies.' }), ZDR)).description
    ).toBe('Makes movies.');
  });

  it('omits description when the source carries none — absence never excludes', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR))).not.toHaveProperty('description');
  });

  it('carries the source display name into descriptor content for every family', () => {
    expect(normalized(normalizeModel(languageModel({ name: 'GPT Test' }), ZDR)).name).toBe(
      'GPT Test'
    );
    expect(normalized(normalizeModel(imageModel({ name: 'Draw Test' }), ZDR)).name).toBe(
      'Draw Test'
    );
    expect(normalized(normalizeModel(videoModel({ name: 'Film Test' }), ZDR)).name).toBe(
      'Film Test'
    );
  });

  it('omits name when the source carries none — absence never excludes', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR))).not.toHaveProperty('name');
  });

  it('parses a stored descriptor row written before name/description existed (additive-optional)', () => {
    const legacyRow = {
      id: 'openai/legacy',
      provider: 'openai',
      version: '1',
      inputs: ['text'],
      outputs: ['text'],
      parameters: {},
      behaviors: ['streaming'],
      limits: {},
      pricing: {},
      zdrReachable: true,
      releasedAt: 1_700_000_000,
      fetchedAt: 0,
    };
    const parsed = ModelDescriptor.parse(legacyRow);
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
  });

  it('captures the release timestamp as releasedAt', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR)).releasedAt).toBe(1_700_000_000);
  });

  it('excludes a language model with no release date (fail-closed)', () => {
    expect(normalizeModel(languageModel({ releasedAt: undefined }), ZDR)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'missing-release-date',
    });
  });

  it('excludes a language model with a non-positive release date (fail-closed)', () => {
    for (const releasedAt of [0, -1]) {
      expect(normalizeModel(languageModel({ releasedAt }), ZDR)).toEqual({
        kind: 'excluded',
        modelId: 'openai/gpt-test',
        reason: 'missing-release-date',
      });
    }
  });

  it('marks a model unreachable when it is not in the ZDR set', () => {
    expect(normalized(normalizeModel(languageModel(), new Set<string>())).zdrReachable).toBe(false);
  });

  it('filters input modalities outside the closed enum', () => {
    expect(
      normalized(normalizeModel(languageModel({ inputModalities: ['text', 'smell'] }), ZDR)).inputs
    ).toEqual(['text']);
  });

  it('defaults empty input modalities to text', () => {
    expect(normalized(normalizeModel(languageModel({ inputModalities: [] }), ZDR)).inputs).toEqual([
      'text',
    ]);
  });

  it('assigns no language behaviors to a media-only-output model', () => {
    const content = normalized(
      normalizeModel(languageModel({ outputModalities: ['image', 'video'] }), ZDR)
    );
    expect(content.behaviors).toEqual([]);
    expect(content.outputs).toEqual(['image', 'video']);
  });

  it('leaves pricing empty when the model reports none', () => {
    expect(normalized(normalizeModel(languageModel({ pricing: undefined }), ZDR)).pricing).toEqual(
      {}
    );
  });

  it('omits rates left out of a partial pricing object', () => {
    expect(
      normalized(normalizeModel(languageModel({ pricing: { completion: '0.00001' } }), ZDR)).pricing
    ).toEqual({ outputPerToken: '10000' });
  });

  it('omits a rate that cannot be represented in nano-USD', () => {
    expect(
      normalized(
        normalizeModel(
          languageModel({ pricing: { prompt: 'mystery', completion: '0.00001' } }),
          ZDR
        )
      ).pricing
    ).toEqual({ outputPerToken: '10000' });
  });

  it('includes the cache-read rate when reported', () => {
    expect(
      normalized(
        normalizeModel(
          languageModel({
            pricing: { prompt: '0.000002', completion: '0.00001', cacheRead: '0.000001' },
          }),
          ZDR
        )
      ).pricing['cachedInputPerToken']
    ).toBe('1000');
  });

  it('omits limits when there is no context length', () => {
    expect(
      normalized(normalizeModel(languageModel({ contextLength: undefined }), ZDR)).limits
    ).toEqual({});
  });
});

describe('normalizeModel (image)', () => {
  it('normalizes an image model with per-image pricing and derived params', () => {
    const content = normalized(normalizeModel(imageModel(), ZDR));
    expect(content).toMatchObject({
      outputs: ['image'],
      inputs: ['text'],
      behaviors: [],
      pricing: { perImage: '40000000' },
      zdrReachable: true,
    });
    expect(content.parameters['aspectRatio']).toMatchObject({ type: 'enum', values: ['1:1'] });
    expect(content.parameters['resolution']).toMatchObject({ type: 'enum', values: ['1024x1024'] });
    expect(content.parameters['n']).toMatchObject({ type: 'integer', min: 1, max: 4 });
    expect(content.releasedAt).toBe(1_700_000_000);
  });

  it('excludes an image model with no release date (fail-closed)', () => {
    expect(normalizeModel(imageModel({ releasedAt: undefined }), ZDR)).toMatchObject({
      kind: 'excluded',
      reason: 'missing-release-date',
    });
  });

  it('excludes an image model with a non-positive release date (fail-closed)', () => {
    for (const releasedAt of [0, -1]) {
      expect(normalizeModel(imageModel({ releasedAt }), ZDR)).toMatchObject({
        kind: 'excluded',
        reason: 'missing-release-date',
      });
    }
  });

  it('ignores non-output rows so an image-unit input rate never prices the model (fail-closed)', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [
            { billable: 'input_image', unit: 'image', costUsd: '0.04' },
            { billable: 'output_image', unit: 'megapixel', costUsd: '0.01' },
          ],
        }),
        ZDR
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes an image model whose output is priced per megapixel (fail-closed)', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'megapixel', costUsd: '0.01' }],
        }),
        ZDR
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes an image model whose output is priced per token (fail-closed)', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'token', costUsd: '0.00003' }],
        }),
        ZDR
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'unknown-pricing-unit',
    });
  });

  it('omits image params when the structured surface is empty', () => {
    const content = normalized(
      normalizeModel(
        imageModel({ supportedParameters: { resolution: [], aspectRatio: [], maxN: undefined } }),
        ZDR
      )
    );
    expect(content.parameters).toEqual({});
  });

  it('excludes an image model whose only per-image rate is unrepresentable in nano-USD', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'image', costUsd: 'mystery' }],
        }),
        ZDR
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'unknown-pricing-unit',
    });
  });
});

describe('normalizeModel (video SKU interpreter)', () => {
  it('captures the release timestamp and excludes a video model with no release date', () => {
    expect(normalized(normalizeModel(videoModel(), ZDR)).releasedAt).toBe(1_700_000_000);
    expect(normalizeModel(videoModel({ releasedAt: undefined }), ZDR)).toMatchObject({
      kind: 'excluded',
      reason: 'missing-release-date',
    });
  });

  it('excludes a video model with a non-positive release date (fail-closed)', () => {
    for (const releasedAt of [0, -1]) {
      expect(normalizeModel(videoModel({ releasedAt }), ZDR)).toMatchObject({
        kind: 'excluded',
        reason: 'missing-release-date',
      });
    }
  });

  it('interprets USD-per-second SKUs keyed by resolution', () => {
    const content = normalized(
      normalizeModel(
        videoModel({
          pricingSkus: { duration_seconds_720p: '0.0988', duration_seconds_1080p: '0.15' },
        }),
        ZDR
      )
    );
    expect(content.pricing).toEqual({
      perSecondByResolution: { '720p': '98800000', '1080p': '150000000' },
    });
    expect(content.outputs).toEqual(['video']);
  });

  it('interprets cents-per-second SKUs by dividing by one hundred', () => {
    const content = normalized(
      normalizeModel(videoModel({ pricingSkus: { cents_per_video_output_second_480p: '5' } }), ZDR)
    );
    // 5 cents/sec = 0.05 USD/sec = 50_000_000 nano-USD.
    expect(content.pricing).toEqual({ perSecondByResolution: { '480p': '50000000' } });
  });

  it('interprets multi-digit cents SKUs (whole-part shift)', () => {
    const content = normalized(
      normalizeModel(
        videoModel({ pricingSkus: { cents_per_video_output_second_720p: '150' } }),
        ZDR
      )
    );
    // 150 cents/sec = 1.50 USD/sec = 1_500_000_000 nano-USD.
    expect(content.pricing).toEqual({ perSecondByResolution: { '720p': '1500000000' } });
  });

  it('keeps the first bare rate when two non-audio SKUs share a resolution', () => {
    const content = normalized(
      normalizeModel(
        videoModel({
          pricingSkus: { duration_seconds_720p: '0.1', cents_per_video_output_second_720p: '15' },
        }),
        ZDR
      )
    );
    expect(content.pricing).toEqual({ perSecondByResolution: { '720p': '100000000' } });
  });

  it('prefers the audio-inclusive rate over the bare rate per resolution', () => {
    const content = normalized(
      normalizeModel(
        videoModel({
          pricingSkus: { duration_seconds: '0.112', duration_seconds_with_audio: '0.168' },
        }),
        ZDR
      )
    );
    expect(content.pricing).toEqual({ perSecondByResolution: { default: '168000000' } });
  });

  it('excludes a video model with an unknown pricing unit', () => {
    expect(normalizeModel(videoModel({ pricingSkus: { per_video_token: '0.001' } }), ZDR)).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('omits a SKU whose value cannot be represented in nano-USD', () => {
    const content = normalized(
      normalizeModel(
        videoModel({
          pricingSkus: { duration_seconds_720p: 'mystery', duration_seconds_1080p: '0.15' },
        }),
        ZDR
      )
    );
    expect(content.pricing).toEqual({ perSecondByResolution: { '1080p': '150000000' } });
  });

  it('leaves pricing empty when every SKU value is unparseable', () => {
    const content = normalized(
      normalizeModel(videoModel({ pricingSkus: { duration_seconds: 'mystery' } }), ZDR)
    );
    expect(content.pricing).toEqual({});
  });

  it('derives video params and frame-image input support', () => {
    const content = normalized(normalizeModel(videoModel({ supportsFrameImages: true }), ZDR));
    expect(content.inputs).toEqual(['text', 'image']);
    expect(content.parameters['resolution']).toMatchObject({
      type: 'enum',
      values: ['720p', '1080p'],
    });
    expect(content.parameters['aspectRatio']).toMatchObject({ type: 'enum', values: ['16:9'] });
    expect(content.parameters['duration']).toMatchObject({ type: 'enum', values: ['4', '8'] });
    expect(content.parameters['generateAudio']).toMatchObject({ type: 'boolean' });
    expect(content.parameters['seed']).toMatchObject({ type: 'integer' });
  });

  it('omits optional video params when absent', () => {
    const content = normalized(
      normalizeModel(
        videoModel({
          resolutions: [],
          aspectRatios: [],
          durations: [],
          generateAudio: false,
          seed: false,
        }),
        ZDR
      )
    );
    expect(content.parameters).toEqual({});
  });
});

describe('normalizeCatalog (dedupe + merge by id)', () => {
  function onlyNormalized(entry: CatalogEntry | undefined): DescriptorContent {
    if (entry?.kind !== 'normalized') {
      throw new Error(`expected a normalized entry, got ${entry?.kind ?? 'undefined'}`);
    }
    return entry.content;
  }

  it('leaves disjoint ids as separate entries (cheap no-op)', () => {
    const entries = normalizeCatalog(
      [languageModel({ id: 'a/lang' }), imageModel({ id: 'b/img' })],
      new Set(['a/lang', 'b/img'])
    );
    expect(entries.map((entry) => entry.modelId).toSorted((x, y) => x.localeCompare(y))).toEqual([
      'a/lang',
      'b/img',
    ]);
  });

  it('merges a duplicate id across families into one entry with unioned outputs', () => {
    const entries = normalizeCatalog(
      [languageModel({ id: 'dup/model' }), imageModel({ id: 'dup/model' })],
      new Set(['dup/model'])
    );
    expect(entries).toHaveLength(1);
    const content = onlyNormalized(entries[0]);
    expect(content.outputs).toEqual(['text', 'image']);
  });

  it('keeps language behaviors on a merged text+image model (streaming survives)', () => {
    const entries = normalizeCatalog(
      [languageModel({ id: 'dup/model' }), imageModel({ id: 'dup/model' })],
      new Set(['dup/model'])
    );
    expect(onlyNormalized(entries[0]).behaviors).toContain('streaming');
  });

  it('produces identical merged content regardless of the source order (no oscillation)', () => {
    const forward = normalizeCatalog(
      [languageModel({ id: 'ord/model' }), imageModel({ id: 'ord/model' })],
      new Set(['ord/model'])
    );
    const reversed = normalizeCatalog(
      [imageModel({ id: 'ord/model' }), languageModel({ id: 'ord/model' })],
      new Set(['ord/model'])
    );
    expect(forward).toEqual(reversed);
  });

  it('keeps the normalized sibling when a same-id sibling is excluded', () => {
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'mix/model' }),
        imageModel({
          id: 'mix/model',
          endpointPricing: [{ billable: 'output_image', unit: 'megapixel', costUsd: '0.01' }],
        }),
      ],
      new Set(['mix/model'])
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('normalized');
  });

  it('excludes an id only when every sibling for it is excluded', () => {
    const entries = normalizeCatalog(
      [languageModel({ id: 'dep/model', deprecated: true })],
      new Set()
    );
    expect(entries).toEqual([{ kind: 'excluded', modelId: 'dep/model', reason: 'deprecated' }]);
  });
});
