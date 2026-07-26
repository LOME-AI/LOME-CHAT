import { describe, expect, it } from 'vitest';
import { ModelDescriptor } from '@hushbox/shared';
import { MAX_MODEL_AGE_MS } from '@hushbox/shared/affordability';
import { normalizeCatalog, normalizeModel } from './normalize.js';
import { isNonConversational } from './non-chat-exclusions.js';
import type { ImageMetadata, LanguageMetadata, VideoMetadata } from './gateway-metadata.js';
import type { CatalogAdmission, CatalogEntry, DescriptorContent } from './normalize.js';

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
    pricingSkus: { duration_seconds_720p: '0.0988', duration_seconds_1080p: '0.15' },
    releasedAt: 1_700_000_000,
    ...overrides,
  };
}

const ZDR: ReadonlySet<string> = new Set([
  'openai/gpt-test',
  'google/test-image',
  'google/test-video',
]);

/** The refresh clock the fixtures are dated against — a few weeks after every
 * fixture's `releasedAt`, so the age cutoff passes unless a test dates a model
 * deliberately old. */
const NOW_MS = Date.UTC(2024, 0, 1);

/** A release date one second past the age cutoff, derived from the constant so
 * the boundary cannot drift away from the rule. */
const OLDER_THAN_LIMIT_SECONDS = Math.trunc((NOW_MS - MAX_MODEL_AGE_MS) / 1000) - 1;

/** Pool-relative admission inputs. `ADMISSION` holds the context exemption
 * above every fixture's context length, so the price floor and the age cutoff
 * are the live rules. */
const ADMISSION: CatalogAdmission = { contextExemptionTokens: 1_000_000_000, nowMs: NOW_MS };

/** The exemption a small pool produces: every context length is in the top
 * percentile, so the floor and the cutoff are both bypassed. Used by fixtures
 * that state a sub-floor rate in order to exercise something else. */
const EXEMPT: CatalogAdmission = { contextExemptionTokens: 0, nowMs: NOW_MS };

function normalized(outcome: ReturnType<typeof normalizeModel>): DescriptorContent {
  if (outcome.kind !== 'normalized') throw new Error(`expected normalized, got ${outcome.kind}`);
  return outcome.content;
}

describe('normalizeModel (language)', () => {
  it('normalizes a language model into descriptor content', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION))).toMatchObject({
      id: 'openai/gpt-test',
      provider: 'openai',
      inputs: ['text', 'image'],
      outputs: ['text'],
      behaviors: ['streaming', 'tools', 'reasoning'],
      limits: { contextLength: 128_000 },
      pricing: { inputPerToken: '2875', outputPerToken: '11500' },
      zdrReachable: true,
    });
  });

  it('never carries the gateway popularityRank into descriptor content', () => {
    const content = normalized(
      normalizeModel(languageModel({ popularityRank: 7 }), ZDR, ADMISSION)
    );
    expect('popularityRank' in content).toBe(false);
  });

  it('seeds parameter specs from supported parameter names', () => {
    const content = normalized(normalizeModel(languageModel(), ZDR, ADMISSION));
    expect(content.parameters['temperature']).toMatchObject({ type: 'number', wire: 'firstClass' });
    expect(content.parameters['topP']).toMatchObject({ type: 'number' });
    expect(content.parameters['maxOutputTokens']).toMatchObject({ type: 'integer' });
  });

  it('skips supported parameter names without a known spec', () => {
    const content = normalized(
      normalizeModel(
        languageModel({ supportedParameters: ['temperature', 'mystery_knob'] }),
        ZDR,
        ADMISSION
      )
    );
    expect(Object.keys(content.parameters)).toEqual(['temperature']);
  });

  it('carries the gateway reasoning metadata into descriptor content', () => {
    const content = normalized(
      normalizeModel(
        languageModel({
          reasoning: {
            mandatory: true,
            supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'none'],
            defaultEffort: 'medium',
            defaultEnabled: true,
          },
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.reasoning).toEqual({
      mandatory: true,
      supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'none'],
      defaultEffort: 'medium',
      defaultEnabled: true,
    });
  });

  it('leaves the reasoning field absent when the gateway carries no reasoning object', () => {
    const content = normalized(normalizeModel(languageModel(), ZDR, ADMISSION));
    expect('reasoning' in content).toBe(false);
  });

  it('round-trips a reasoning-carrying descriptor through the persisted jsonb schema', () => {
    const content = normalized(
      normalizeModel(
        languageModel({ reasoning: { mandatory: false, supportedEfforts: null } }),
        ZDR,
        ADMISSION
      )
    );
    const parsed = ModelDescriptor.parse({ ...content, fetchedAt: 0 });
    expect(parsed.reasoning).toEqual({ mandatory: false, supportedEfforts: null });
  });

  it('excludes a model whose output modalities classify to no family', () => {
    expect(normalizeModel(languageModel({ outputModalities: ['smell'] }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'unclassifiable-modality',
    });
  });

  it('excludes a model with empty output modalities', () => {
    expect(normalizeModel(languageModel({ outputModalities: [] }), ZDR, ADMISSION)).toMatchObject({
      kind: 'excluded',
      reason: 'unclassifiable-modality',
    });
  });

  it('excludes a deprecated model', () => {
    expect(normalizeModel(languageModel({ deprecated: true }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'deprecated',
    });
  });

  it('carries the source description into descriptor content for every family', () => {
    expect(
      normalized(
        normalizeModel(languageModel({ description: 'Fast frontier model.' }), ZDR, ADMISSION)
      ).description
    ).toBe('Fast frontier model.');
    expect(
      normalized(normalizeModel(imageModel({ description: 'Draws pictures.' }), ZDR, ADMISSION))
        .description
    ).toBe('Draws pictures.');
    expect(
      normalized(normalizeModel(videoModel({ description: 'Makes movies.' }), ZDR, ADMISSION))
        .description
    ).toBe('Makes movies.');
  });

  it('omits description when the source carries none — absence never excludes', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION))).not.toHaveProperty(
      'description'
    );
  });

  it('carries the source display name into descriptor content for every family', () => {
    expect(
      normalized(normalizeModel(languageModel({ name: 'GPT Test' }), ZDR, ADMISSION)).name
    ).toBe('GPT Test');
    expect(normalized(normalizeModel(imageModel({ name: 'Draw Test' }), ZDR, ADMISSION)).name).toBe(
      'Draw Test'
    );
    expect(normalized(normalizeModel(videoModel({ name: 'Film Test' }), ZDR, ADMISSION)).name).toBe(
      'Film Test'
    );
  });

  it('omits name when the source carries none — absence never excludes', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION))).not.toHaveProperty('name');
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
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION)).releasedAt).toBe(
      1_700_000_000
    );
  });

  it('excludes a language model with no release date (fail-closed)', () => {
    expect(normalizeModel(languageModel({ releasedAt: undefined }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'missing-release-date',
    });
  });

  it('excludes a language model with a non-positive release date (fail-closed)', () => {
    for (const releasedAt of [0, -1]) {
      expect(normalizeModel(languageModel({ releasedAt }), ZDR, ADMISSION)).toEqual({
        kind: 'excluded',
        modelId: 'openai/gpt-test',
        reason: 'missing-release-date',
      });
    }
  });

  it('excludes a language model not in the ZDR set (only ZDR models are persisted)', () => {
    expect(normalizeModel(languageModel(), new Set<string>(), ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'non-zdr',
    });
  });

  it('filters input modalities outside the closed enum', () => {
    expect(
      normalized(
        normalizeModel(languageModel({ inputModalities: ['text', 'smell'] }), ZDR, ADMISSION)
      ).inputs
    ).toEqual(['text']);
  });

  it('defaults empty input modalities to text', () => {
    expect(
      normalized(normalizeModel(languageModel({ inputModalities: [] }), ZDR, ADMISSION)).inputs
    ).toEqual(['text']);
  });

  it('assigns no language behaviors to a media-only-output model', () => {
    const content = normalized(
      normalizeModel(languageModel({ outputModalities: ['image', 'video'] }), ZDR, ADMISSION)
    );
    expect(content.behaviors).toEqual([]);
    expect(content.outputs).toEqual(['image', 'video']);
  });

  it('leaves pricing empty when a media model reports none', () => {
    // The language path has no such outcome: a text model that states no rate
    // has a combined rate of zero and is excluded by catalog admission.
    expect(
      normalized(normalizeModel(videoModel({ resolutions: [] }), ZDR, ADMISSION)).pricing
    ).toEqual({});
  });

  it('omits rates left out of a partial pricing object', () => {
    expect(
      normalized(
        normalizeModel(languageModel({ pricing: { completion: '0.00001' } }), ZDR, ADMISSION)
      ).pricing
    ).toEqual({ outputPerToken: '11500' });
  });

  it('omits a rate that cannot be represented in nano-USD', () => {
    expect(
      normalized(
        normalizeModel(
          languageModel({ pricing: { prompt: 'mystery', completion: '0.00001' } }),
          ZDR,
          ADMISSION
        )
      ).pricing
    ).toEqual({ outputPerToken: '11500' });
  });

  it('includes the cache-read rate when reported', () => {
    expect(
      normalized(
        normalizeModel(
          languageModel({
            pricing: { prompt: '0.000002', completion: '0.00001', cacheRead: '0.000001' },
          }),
          ZDR,
          ADMISSION
        )
      ).pricing['cachedInputPerToken']
    ).toBe('1150');
  });

  it('omits limits when there is no context length', () => {
    expect(
      normalized(normalizeModel(languageModel({ contextLength: undefined }), ZDR, ADMISSION)).limits
    ).toEqual({});
  });

  it('writes limits.maxOutputTokens from a positive-integer gateway ceiling', () => {
    expect(
      normalized(normalizeModel(languageModel({ maxCompletionTokens: 16_384 }), ZDR, ADMISSION))
        .limits
    ).toEqual({ contextLength: 128_000, maxOutputTokens: 16_384 });
  });

  it('omits maxOutputTokens when the gateway reports no ceiling', () => {
    expect(
      normalized(normalizeModel(languageModel({ maxCompletionTokens: undefined }), ZDR, ADMISSION))
        .limits
    ).toEqual({ contextLength: 128_000 });
  });

  it('omits maxOutputTokens when the gateway ceiling is not a positive integer', () => {
    for (const nonsensical of [0, -1, 0.5]) {
      expect(
        normalized(
          normalizeModel(languageModel({ maxCompletionTokens: nonsensical }), ZDR, ADMISSION)
        ).limits
      ).toEqual({ contextLength: 128_000 });
    }
  });
});

describe('normalizeModel (specialty exclusions)', () => {
  const NO_ZDR: ReadonlySet<string> = new Set<string>();

  it('excludes a non-ZDR model for each family with reason non-zdr', () => {
    expect(normalizeModel(languageModel(), NO_ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'non-zdr',
    });
    expect(normalizeModel(imageModel(), NO_ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'non-zdr',
    });
    expect(normalizeModel(videoModel(), NO_ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'non-zdr',
    });
  });

  it('non-zdr wins over an otherwise-quiet exclusion reason', () => {
    expect(normalizeModel(languageModel({ deprecated: true }), NO_ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'non-zdr',
    });
  });

  it('excludes a ZDR-reachable model from the banned provider relace', () => {
    expect(
      normalizeModel(
        languageModel({ id: 'relace/relace-apply-3', provider: 'relace' }),
        new Set(['relace/relace-apply-3']),
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'relace/relace-apply-3',
      reason: 'non-conversational',
    });
  });

  it('excludes a ZDR-reachable model from the banned provider morph', () => {
    expect(
      normalizeModel(
        languageModel({ id: 'morph/morph-v3-large', provider: 'morph' }),
        new Set(['morph/morph-v3-large']),
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'morph/morph-v3-large',
      reason: 'non-conversational',
    });
  });

  it('excludes a ZDR-reachable moderation model by its guard/safeguard id or name', () => {
    // Id matches the guard heuristic but is not a denylist member and its
    // provider is not banned — isolating the id-regex branch.
    expect(
      normalizeModel(
        languageModel({ id: 'acme/acme-guard-9b', provider: 'acme' }),
        new Set(['acme/acme-guard-9b']),
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'acme/acme-guard-9b',
      reason: 'non-conversational',
    });
    // Name-only match: id is clean, the display name carries "Safeguard".
    expect(
      normalizeModel(
        languageModel({ id: 'acme/chat-42', provider: 'acme', name: 'Acme Safeguard' }),
        new Set(['acme/chat-42']),
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'acme/chat-42',
      reason: 'non-conversational',
    });
  });

  it('excludes a ZDR-reachable model whose id is on the explicit denylist', () => {
    // A denylisted id with a non-banned provider and no guard/safeguard token,
    // so only the explicit denylist catches it — isolating that branch.
    expect(
      normalizeModel(
        languageModel({ id: 'morph/morph-v3-fast', provider: 'not-banned', name: 'Fast Coder' }),
        new Set(['morph/morph-v3-fast']),
        ADMISSION
      )
    ).toMatchObject({ kind: 'excluded', reason: 'non-conversational' });
  });

  it('still normalizes a ZDR-reachable general chat model (no over-exclusion)', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION)).zdrReachable).toBe(true);
  });

  // Perplexity `sonar` models are conversational search models and must stay
  // in the catalog — they superficially resemble "search" specialty models but
  // are not non-conversational. This guard pins the product decision so a future
  // denylist/regex change can't silently exclude them.
  it('keeps the Perplexity sonar family (conversational search, never a specialty exclusion)', () => {
    const sonarIds = [
      'perplexity/sonar',
      'perplexity/sonar-pro',
      'perplexity/sonar-reasoning',
      'perplexity/sonar-deep-research',
      'perplexity/sonar-pro-search',
    ];
    const noName: string | undefined = undefined;
    for (const id of sonarIds) {
      expect(isNonConversational(id, 'perplexity', noName)).toBe(false);
      expect(
        normalizeModel(languageModel({ id, provider: 'perplexity' }), new Set([id]), ADMISSION)
      ).toMatchObject({ kind: 'normalized' });
    }
  });
});

describe('normalizeModel (image)', () => {
  it('normalizes an image model with per-image pricing and derived params', () => {
    const content = normalized(normalizeModel(imageModel(), ZDR, ADMISSION));
    expect(content).toMatchObject({
      outputs: ['image'],
      inputs: ['text'],
      behaviors: [],
      pricing: { perImage: '46000000' },
      zdrReachable: true,
    });
    expect(content.parameters['aspectRatio']).toMatchObject({ type: 'enum', values: ['1:1'] });
    expect(content.parameters['resolution']).toMatchObject({ type: 'enum', values: ['1024x1024'] });
    expect(content.parameters['n']).toMatchObject({ type: 'integer', min: 1, max: 4 });
    expect(content.releasedAt).toBe(1_700_000_000);
  });

  it('carries no limits — image models have no token-cap concept', () => {
    expect(normalized(normalizeModel(imageModel(), ZDR, ADMISSION)).limits).toEqual({});
  });

  it('excludes an image model with no release date (fail-closed)', () => {
    expect(normalizeModel(imageModel({ releasedAt: undefined }), ZDR, ADMISSION)).toMatchObject({
      kind: 'excluded',
      reason: 'missing-release-date',
    });
  });

  it('excludes an image model with a non-positive release date (fail-closed)', () => {
    for (const releasedAt of [0, -1]) {
      expect(normalizeModel(imageModel({ releasedAt }), ZDR, ADMISSION)).toMatchObject({
        kind: 'excluded',
        reason: 'missing-release-date',
      });
    }
  });

  it('ignores non-output rows so an image-unit input rate never prices the model', () => {
    // The input_image image-unit row must not price the model; the output row is
    // megapixel, so the model is excluded (quietly) rather than priced off the input.
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [
            { billable: 'input_image', unit: 'image', costUsd: '0.04' },
            { billable: 'output_image', unit: 'megapixel', costUsd: '0.01' },
          ],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'megapixel-priced-image',
    });
  });

  it('excludes a megapixel-priced image model quietly (megapixel-priced-image, not a defect)', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'megapixel', costUsd: '0.01' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'megapixel-priced-image',
    });
  });

  it('excludes an image model with no output pricing rows quietly (missing-pricing)', () => {
    expect(normalizeModel(imageModel({ endpointPricing: [] }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'missing-pricing',
    });
  });

  it('excludes an image model whose only output row has a per-input role quietly (missing-pricing)', () => {
    // Only input_image rows means no output pricing exists at all — missing, not unknown.
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'input_image', unit: 'megapixel', costUsd: '0.06' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toMatchObject({ kind: 'excluded', reason: 'missing-pricing' });
  });

  it('loudly excludes an image model whose output unit is genuinely unrecognized', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'furlong', costUsd: '0.01' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes a token-priced image model quietly (token-priced-image, not a defect)', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'token', costUsd: '0.00003' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'token-priced-image',
    });
  });

  it('treats any per-token output unit as token-priced-image, not unknown', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'output_token', costUsd: '0.00003' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toMatchObject({ kind: 'excluded', reason: 'token-priced-image' });
  });

  it('prices per-image when both a token row and a per-image row exist', () => {
    const content = normalized(
      normalizeModel(
        imageModel({
          endpointPricing: [
            { billable: 'output_image', unit: 'token', costUsd: '0.00003' },
            { billable: 'output_image', unit: 'image', costUsd: '0.04' },
          ],
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.pricing).toEqual({ perImage: '46000000' });
  });

  it('omits image params when the structured surface is empty', () => {
    const content = normalized(
      normalizeModel(
        imageModel({ supportedParameters: { resolution: [], aspectRatio: [], maxN: undefined } }),
        ZDR,
        ADMISSION
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
        ZDR,
        ADMISSION
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
    expect(normalized(normalizeModel(videoModel(), ZDR, ADMISSION)).releasedAt).toBe(1_700_000_000);
    expect(normalizeModel(videoModel({ releasedAt: undefined }), ZDR, ADMISSION)).toMatchObject({
      kind: 'excluded',
      reason: 'missing-release-date',
    });
  });

  it('carries no limits — video models have no token-cap concept', () => {
    expect(normalized(normalizeModel(videoModel(), ZDR, ADMISSION)).limits).toEqual({});
  });

  it('excludes a video model with a non-positive release date (fail-closed)', () => {
    for (const releasedAt of [0, -1]) {
      expect(normalizeModel(videoModel({ releasedAt }), ZDR, ADMISSION)).toMatchObject({
        kind: 'excluded',
        reason: 'missing-release-date',
      });
    }
  });

  /** Assert a video model normalizes and return its outcome (so tests can read
   * `pricingFallbacks` — the loud substitution flag — alongside content). */
  function videoOutcome(
    overrides: Partial<VideoMetadata>
  ): Extract<ReturnType<typeof normalizeModel>, { kind: 'normalized' }> {
    const outcome = normalizeModel(videoModel(overrides), ZDR, ADMISSION);
    if (outcome.kind !== 'normalized') throw new Error(`expected normalized, got ${outcome.kind}`);
    return outcome;
  }

  it('keys the matrix on supported_resolutions (USD-per-second), no fallback', () => {
    const outcome = videoOutcome({
      resolutions: ['720p', '1080p'],
      pricingSkus: { duration_seconds_720p: '0.0988', duration_seconds_1080p: '0.15' },
    });
    expect(outcome.content.pricing).toEqual({
      perSecondByResolution: { '720p': '113620000', '1080p': '172500000' },
    });
    expect(outcome.content.outputs).toEqual(['video']);
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('interprets cents-per-second SKUs by dividing by one hundred', () => {
    const content = videoOutcome({
      resolutions: ['480p'],
      pricingSkus: { cents_per_video_output_second_480p: '5' },
    }).content;
    // 5 cents/sec = 0.05 USD/sec = 50_000_000 nano-USD provider → 57_500_000 billable.
    expect(content.pricing).toEqual({ perSecondByResolution: { '480p': '57500000' } });
  });

  it('interprets multi-digit cents SKUs (whole-part shift)', () => {
    const content = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: { cents_per_video_output_second_720p: '150' },
    }).content;
    // 150 cents/sec = 1.50 USD/sec = 1_500_000_000 nano-USD provider → 1_725_000_000 billable.
    expect(content.pricing).toEqual({ perSecondByResolution: { '720p': '1725000000' } });
  });

  it('keeps the first bare rate when two non-audio SKUs share a resolution', () => {
    const content = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: { duration_seconds_720p: '0.1', cents_per_video_output_second_720p: '15' },
    }).content;
    expect(content.pricing).toEqual({ perSecondByResolution: { '720p': '115000000' } });
  });

  it('applies a flat rate to every supported resolution with no loud fallback', () => {
    // wan-2.7: a single flat `duration_seconds` prices all declared resolutions;
    // a stated flat rate is not a substitution, so no fallback is flagged.
    const outcome = videoOutcome({
      resolutions: ['720p', '1080p'],
      pricingSkus: { duration_seconds: '0.1' },
    });
    expect(outcome.content.pricing).toEqual({
      perSecondByResolution: { '720p': '115000000', '1080p': '115000000' },
    });
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('prefers a flat audio-inclusive rate over the bare flat rate (tier c over d)', () => {
    const content = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: { duration_seconds: '0.112', duration_seconds_with_audio: '0.168' },
    }).content;
    expect(content.pricing).toEqual({ perSecondByResolution: { '720p': '193200000' } });
  });

  it('chooses a bare resolution rate over a flat audio rate (tier b beats tier c)', () => {
    // kling-v3.0-pro: 720p has a bare text_to_video rate (tier b) and there is
    // also a flat+audio rate (tier c); tier b wins, and image_to_video is dropped.
    const outcome = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: {
        duration_seconds: '0.112',
        duration_seconds_with_audio: '0.168',
        text_to_video_duration_seconds_480p: '0.112',
        text_to_video_duration_seconds_720p: '0.112',
        image_to_video_duration_seconds_720p: '0.112',
        text_to_video_duration_seconds_1080p: '0.112',
        image_to_video_duration_seconds_1080p: '0.112',
      },
    });
    expect(outcome.content.pricing).toEqual({ perSecondByResolution: { '720p': '128800000' } });
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('drops image_to_video, drops the no-audio tier, and matches 4K case-insensitively', () => {
    // veo-3.1-fast: 720p → res+audio (a), 1080p → flat+audio (c), 4K → res+audio
    // via a lower-case `4k` token matched to the `4K` supported value.
    const outcome = videoOutcome({
      resolutions: ['720p', '1080p', '4K'],
      pricingSkus: {
        duration_seconds_with_audio: '0.12',
        duration_seconds_with_audio_4k: '0.30',
        duration_seconds_without_audio: '0.10',
        duration_seconds_with_audio_720p: '0.10',
        duration_seconds_without_audio_4k: '0.25',
        duration_seconds_without_audio_720p: '0.08',
      },
    });
    expect(outcome.content.pricing).toEqual({
      perSecondByResolution: { '720p': '115000000', '1080p': '138000000', '4K': '345000000' },
    });
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('drops image_to_video SKUs and ignores resolutions outside supported (wan-2.6)', () => {
    const outcome = videoOutcome({
      resolutions: ['720p', '1080p'],
      pricingSkus: {
        text_to_video_duration_seconds_480p: '0.04',
        text_to_video_duration_seconds_720p: '0.08',
        text_to_video_duration_seconds_1080p: '0.12',
        image_to_video_duration_seconds_720p: '0.10',
        image_to_video_duration_seconds_1080p: '0.15',
      },
    });
    expect(outcome.content.pricing).toEqual({
      perSecondByResolution: { '720p': '92000000', '1080p': '138000000' },
    });
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('prices per-resolution from cents and skips input-role SKUs (grok-imagine-video)', () => {
    const outcome = videoOutcome({
      resolutions: ['480p', '720p'],
      pricingSkus: {
        cents_per_image_input: '2',
        cents_per_video_output_second_480p: '5',
        cents_per_video_output_second_720p: '8',
      },
    });
    expect(outcome.content.pricing).toEqual({
      perSecondByResolution: { '480p': '57500000', '720p': '92000000' },
    });
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('substitutes the max known rate with a LOUD fallback for an unpriced resolution', () => {
    // Synthetic tier-e: 1080p is declared but only a 480p rate exists → 1080p
    // takes the model's max known rate and is flagged for a human to verify.
    const outcome = videoOutcome({
      resolutions: ['1080p'],
      pricingSkus: { text_to_video_duration_seconds_480p: '0.05' },
    });
    expect(outcome.content.pricing).toEqual({ perSecondByResolution: { '1080p': '57500000' } });
    expect(outcome.pricingFallbacks).toEqual(['1080p']);
  });

  it('falls back loudly for a resolution whose only SKU value is unrepresentable', () => {
    const outcome = videoOutcome({
      resolutions: ['720p', '1080p'],
      pricingSkus: { duration_seconds_720p: 'mystery', duration_seconds_1080p: '0.15' },
    });
    expect(outcome.content.pricing).toEqual({
      perSecondByResolution: { '720p': '172500000', '1080p': '172500000' },
    });
    expect(outcome.pricingFallbacks).toEqual(['720p']);
  });

  it('excludes a token-priced video model quietly (token-priced-video)', () => {
    expect(
      normalizeModel(
        videoModel({ pricingSkus: { video_tokens: '0.001', video_tokens_without_audio: '0.001' } }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'token-priced-video',
    });
  });

  it('excludes a video model with an unknown pricing unit (loud, fail-closed)', () => {
    expect(
      normalizeModel(videoModel({ pricingSkus: { per_video_token: '0.001' } }), ZDR, ADMISSION)
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes a video model with no usable rate for its declared resolutions', () => {
    // Every SKU value unparseable → zero usable rates → fail-closed exclusion,
    // never an exposed model whose declared resolutions have no price.
    expect(
      normalizeModel(
        videoModel({ resolutions: ['720p'], pricingSkus: { duration_seconds: 'mystery' } }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('exposes an empty pricing matrix when the model declares no resolutions', () => {
    const content = normalized(
      normalizeModel(
        videoModel({ resolutions: [], pricingSkus: { duration_seconds: '0.1' } }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.pricing).toEqual({});
  });

  it('derives video params and frame-image input support', () => {
    const content = normalized(
      normalizeModel(videoModel({ supportsFrameImages: true }), ZDR, ADMISSION)
    );
    expect(content.inputs).toEqual(['text', 'image']);
    expect(content.parameters['resolution']).toMatchObject({
      type: 'enum',
      values: ['720p', '1080p'],
    });
    expect(content.parameters['aspectRatio']).toMatchObject({ type: 'enum', values: ['16:9'] });
    expect(content.parameters['durationSeconds']).toMatchObject({ type: 'enum', values: [4, 8] });
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
        ZDR,
        ADMISSION
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
      new Set(['a/lang', 'b/img']),
      NOW_MS
    );
    expect(entries.map((entry) => entry.modelId).toSorted((x, y) => x.localeCompare(y))).toEqual([
      'a/lang',
      'b/img',
    ]);
  });

  it('excludes a merged dual-output model as non-runnable (never persisted)', () => {
    // A slug advertised on both /models (text) and /images (image) merges to
    // outputs ['text','image'] — two outputs, which no turn can run. Admission
    // denies it quietly rather than persisting an unrunnable catalog row.
    const entries = normalizeCatalog(
      [languageModel({ id: 'dup/model' }), imageModel({ id: 'dup/model' })],
      new Set(['dup/model']),
      NOW_MS
    );
    expect(entries).toEqual([
      { kind: 'excluded', modelId: 'dup/model', reason: 'non-runnable-shape' },
    ]);
  });

  it('excludes a merged non-text multi-output model (image+video) as non-runnable', () => {
    const entries = normalizeCatalog(
      [imageModel({ id: 'dup/av' }), videoModel({ id: 'dup/av' })],
      new Set(['dup/av']),
      NOW_MS
    );
    expect(entries).toEqual([
      { kind: 'excluded', modelId: 'dup/av', reason: 'non-runnable-shape' },
    ]);
  });

  it('excludes a single-source dual-output model as non-runnable at admission', () => {
    const entries = normalizeCatalog(
      [languageModel({ id: 'solo/multi', outputModalities: ['text', 'video'] })],
      new Set(['solo/multi']),
      NOW_MS
    );
    expect(entries).toEqual([
      { kind: 'excluded', modelId: 'solo/multi', reason: 'non-runnable-shape' },
    ]);
  });

  it('keeps language behaviors on a merged single-output model (streaming survives)', () => {
    // Two same-id language endpoints merge to a single text output (runnable);
    // the merged behaviors keep streaming and gain the sibling's tools.
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'dup/model', supportedParameters: ['temperature'] }),
        languageModel({ id: 'dup/model', supportedParameters: ['tools'] }),
      ],
      new Set(['dup/model']),
      NOW_MS
    );
    const content = onlyNormalized(entries[0]);
    expect(content.outputs).toEqual(['text']);
    expect(content.behaviors).toEqual(['streaming', 'tools']);
  });

  it('admits runnable shapes: text→text, vision (text+image in → text), and text→image', () => {
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'run/text', inputModalities: ['text'], outputModalities: ['text'] }),
        languageModel({
          id: 'run/vision',
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
        }),
        imageModel({ id: 'run/image' }),
      ],
      new Set(['run/text', 'run/vision', 'run/image']),
      NOW_MS
    );
    expect(entries.every((entry) => entry.kind === 'normalized')).toBe(true);
  });

  it('produces identical merged content regardless of the source order (no oscillation)', () => {
    const forward = normalizeCatalog(
      [languageModel({ id: 'ord/model' }), imageModel({ id: 'ord/model' })],
      new Set(['ord/model']),
      NOW_MS
    );
    const reversed = normalizeCatalog(
      [imageModel({ id: 'ord/model' }), languageModel({ id: 'ord/model' })],
      new Set(['ord/model']),
      NOW_MS
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
      new Set(['mix/model']),
      NOW_MS
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('normalized');
  });

  it('carries reasoning through a same-id fold regardless of which sibling declares it', () => {
    const withReasoning = languageModel({
      id: 'dup/lang',
      reasoning: { mandatory: true, supportedEfforts: ['high', 'low'] },
    });
    const withoutReasoning = languageModel({ id: 'dup/lang' });
    const zdr = new Set(['dup/lang']);
    for (const siblings of [
      [withReasoning, withoutReasoning],
      [withoutReasoning, withReasoning],
    ]) {
      const entries = normalizeCatalog(siblings, zdr, NOW_MS);
      expect(onlyNormalized(entries[0]).reasoning).toEqual({
        mandatory: true,
        supportedEfforts: ['high', 'low'],
      });
    }
  });

  it('excludes an id only when every sibling for it is excluded', () => {
    const entries = normalizeCatalog(
      [languageModel({ id: 'dep/model', deprecated: true })],
      new Set(['dep/model']),
      NOW_MS
    );
    expect(entries).toEqual([{ kind: 'excluded', modelId: 'dep/model', reason: 'deprecated' }]);
  });

  it('propagates a video pricing fallback onto the catalog entry', () => {
    const entries = normalizeCatalog(
      [
        videoModel({
          id: 'vid/fallback',
          resolutions: ['1080p'],
          pricingSkus: { text_to_video_duration_seconds_480p: '0.05' },
        }),
      ],
      new Set(['vid/fallback']),
      NOW_MS
    );
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'normalized', pricingFallbacks: ['1080p'] }),
    ]);
  });
});

describe('normalizeModel (fee baking — billable rates, descriptor v2)', () => {
  it("stamps descriptor version '2' on every family", () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION)).version).toBe('2');
    expect(normalized(normalizeModel(imageModel(), ZDR, ADMISSION)).version).toBe('2');
    expect(normalized(normalizeModel(videoModel(), ZDR, ADMISSION)).version).toBe('2');
  });

  it('bakes the ceil-rounded markup into a flat language rate (against the user)', () => {
    // 1 nano provider rate × 1.15 = 1.15 → ceil 2, never the half-even 1. A
    // rate that low is under the catalog price floor, so the fixture rides the
    // top-context exemption to reach the baking step at all.
    expect(
      normalized(normalizeModel(languageModel({ pricing: { prompt: '0.000000001' } }), ZDR, EXEMPT))
        .pricing
    ).toEqual({ inputPerToken: '2' });
  });

  it('marks up a merged same-id fold exactly once per rate', () => {
    const forward = normalizeCatalog(
      [
        languageModel({ id: 'dup/baked', supportedParameters: ['temperature'] }),
        languageModel({ id: 'dup/baked', supportedParameters: ['tools'] }),
      ],
      new Set(['dup/baked']),
      NOW_MS
    );
    const entry = forward[0];
    if (entry?.kind !== 'normalized') throw new Error('expected normalized');
    // 2500/10000 provider nano → 2875/11500 billable — not marked up again on merge.
    expect(entry.content.pricing).toEqual({ inputPerToken: '2875', outputPerToken: '11500' });
    expect(entry.content.version).toBe('2');
  });

  it('marks up a substituted video fallback rate exactly once', () => {
    const outcome = normalizeModel(
      videoModel({
        resolutions: ['720p', '1080p'],
        pricingSkus: { text_to_video_duration_seconds_720p: '0.05' },
      }),
      ZDR,
      ADMISSION
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    // 0.05 USD/sec = 50_000_000 provider nano → 57_500_000 billable for the
    // stated 720p AND the substituted 1080p (the substitute is the same rate,
    // marked up once at the choke point).
    expect(outcome.content.pricing).toEqual({
      perSecondByResolution: { '720p': '57500000', '1080p': '57500000' },
    });
    expect(outcome.pricingFallbacks).toEqual(['1080p']);
  });
});

describe('normalizeModel (catalog admission)', () => {
  /** 100 nano-USD per token on each leg — the $0.0002/1K floor exactly. */
  const AT_FLOOR = { prompt: '0.0000001', completion: '0.0000001' };
  /** One nano under the combined floor. */
  const BELOW_FLOOR = { prompt: '0.000000099', completion: '0.0000001' };
  /** One nano over the combined floor. */
  const ABOVE_FLOOR = { prompt: '0.000000101', completion: '0.0000001' };

  it('excludes a language model whose combined rate is zero', () => {
    expect(
      normalizeModel(languageModel({ pricing: { prompt: '0', completion: '0' } }), ZDR, ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'zero-priced' });
  });

  it('excludes a language model that states no rate at all', () => {
    expect(normalizeModel(languageModel({ pricing: undefined }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'zero-priced',
    });
  });

  it('excludes a language model one nano under the price floor', () => {
    expect(normalizeModel(languageModel({ pricing: BELOW_FLOOR }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'below-price-floor',
    });
  });

  it('admits a language model exactly at the price floor', () => {
    expect(normalizeModel(languageModel({ pricing: AT_FLOOR }), ZDR, ADMISSION).kind).toBe(
      'normalized'
    );
  });

  it('admits a language model one nano over the price floor', () => {
    expect(normalizeModel(languageModel({ pricing: ABOVE_FLOOR }), ZDR, ADMISSION).kind).toBe(
      'normalized'
    );
  });

  it('tests the floor against the pre-fee rate, not the baked billable rate', () => {
    // A rate one nano under the floor clears it once the 15% markup is applied
    // (199 → 229). The floor is a MARGIN floor, so the raw rate decides.
    expect(normalizeModel(languageModel({ pricing: BELOW_FLOOR }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'below-price-floor',
    });
  });

  it('excludes a language model older than the age limit', () => {
    expect(
      normalizeModel(languageModel({ releasedAt: OLDER_THAN_LIMIT_SECONDS }), ZDR, ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'too-old' });
  });

  it('admits a language model exactly at the age limit', () => {
    expect(
      normalizeModel(languageModel({ releasedAt: OLDER_THAN_LIMIT_SECONDS + 1 }), ZDR, ADMISSION)
        .kind
    ).toBe('normalized');
  });

  it('reports the price floor first when a model fails the floor and the age limit', () => {
    expect(
      normalizeModel(
        languageModel({ pricing: BELOW_FLOOR, releasedAt: OLDER_THAN_LIMIT_SECONDS }),
        ZDR,
        ADMISSION
      )
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'below-price-floor' });
  });

  it('exempts a top-context model from the price floor', () => {
    const admission: CatalogAdmission = { contextExemptionTokens: 128_000, nowMs: NOW_MS };

    expect(
      normalizeModel(
        languageModel({ pricing: BELOW_FLOOR, contextLength: 128_000 }),
        ZDR,
        admission
      ).kind
    ).toBe('normalized');
  });

  it('exempts a top-context model from the age limit', () => {
    const admission: CatalogAdmission = { contextExemptionTokens: 128_000, nowMs: NOW_MS };

    expect(
      normalizeModel(
        languageModel({ releasedAt: OLDER_THAN_LIMIT_SECONDS, contextLength: 128_000 }),
        ZDR,
        admission
      ).kind
    ).toBe('normalized');
  });

  it('does not exempt a model one token below the context threshold', () => {
    const admission: CatalogAdmission = { contextExemptionTokens: 128_000, nowMs: NOW_MS };

    expect(
      normalizeModel(
        languageModel({ pricing: BELOW_FLOOR, contextLength: 127_999 }),
        ZDR,
        admission
      )
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'below-price-floor' });
  });

  it('never exempts a zero-priced model, however large its context', () => {
    expect(
      normalizeModel(
        languageModel({ pricing: { prompt: '0', completion: '0' }, contextLength: 100_000_000 }),
        ZDR,
        EXEMPT
      )
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'zero-priced' });
  });

  it('applies no per-token floor or age limit to an image model', () => {
    // Per-unit pricing: a per-token floor has no meaning for it, so a cheap,
    // years-old image model is admitted on its own pricing shape alone.
    expect(
      normalizeModel(
        imageModel({
          releasedAt: OLDER_THAN_LIMIT_SECONDS,
          endpointPricing: [{ billable: 'output_image', unit: 'image', costUsd: '0.0000001' }],
        }),
        ZDR,
        ADMISSION
      ).kind
    ).toBe('normalized');
  });

  it('applies no per-token floor or age limit to a video model', () => {
    expect(
      normalizeModel(
        videoModel({
          releasedAt: OLDER_THAN_LIMIT_SECONDS,
          pricingSkus: { duration_seconds_720p: '0.0000001' },
        }),
        ZDR,
        ADMISSION
      ).kind
    ).toBe('normalized');
  });

  it('reports non-zdr ahead of a commercial exclusion', () => {
    expect(
      normalizeModel(languageModel({ pricing: BELOW_FLOOR }), new Set<string>(), ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'non-zdr' });
  });

  it('reports a missing release date ahead of a commercial exclusion', () => {
    expect(
      normalizeModel(languageModel({ pricing: BELOW_FLOOR, releasedAt: undefined }), ZDR, ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'missing-release-date' });
  });
});

describe('normalizeCatalog (catalog admission over the pool)', () => {
  const BELOW_FLOOR = { prompt: '0.000000099', completion: '0.0000001' };

  function dispositions(entries: readonly CatalogEntry[]): readonly (readonly [string, string])[] {
    return entries.map((entry) =>
      entry.kind === 'excluded'
        ? ([entry.modelId, entry.reason] as const)
        : ([entry.modelId, 'normalized'] as const)
    );
  }

  it('measures the context exemption over the pool, not over one model', () => {
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'small/ctx', contextLength: 8000, pricing: BELOW_FLOOR }),
        languageModel({ id: 'large/ctx', contextLength: 128_000, pricing: BELOW_FLOOR }),
      ],
      new Set(['small/ctx', 'large/ctx']),
      NOW_MS
    );

    expect(dispositions(entries)).toEqual([
      ['small/ctx', 'below-price-floor'],
      ['large/ctx', 'normalized'],
    ]);
  });

  it('leaves a ZDR-unreachable model out of the pool the exemption is measured over', () => {
    // Were the unreachable million-token model counted, the threshold would rise
    // to its context length and `large/ctx` would lose its exemption.
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'small/ctx', contextLength: 8000, pricing: BELOW_FLOOR }),
        languageModel({ id: 'large/ctx', contextLength: 128_000, pricing: BELOW_FLOOR }),
        languageModel({ id: 'hidden/huge', contextLength: 1_000_000, pricing: BELOW_FLOOR }),
      ],
      new Set(['small/ctx', 'large/ctx']),
      NOW_MS
    );

    expect(dispositions(entries)).toEqual([
      ['small/ctx', 'below-price-floor'],
      ['large/ctx', 'normalized'],
      ['hidden/huge', 'non-zdr'],
    ]);
  });

  it('leaves a media model out of the pool the exemption is measured over', () => {
    // Media context lengths are not token contexts; counting them would move a
    // text model's exemption for a reason unrelated to text capability.
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'small/ctx', contextLength: 8000, pricing: BELOW_FLOOR }),
        languageModel({ id: 'large/ctx', contextLength: 128_000, pricing: BELOW_FLOOR }),
        imageModel({ id: 'pic/gen' }),
      ],
      new Set(['small/ctx', 'large/ctx', 'pic/gen']),
      NOW_MS
    );

    expect(dispositions(entries)).toEqual([
      ['small/ctx', 'below-price-floor'],
      ['large/ctx', 'normalized'],
      ['pic/gen', 'normalized'],
    ]);
  });

  it('measures the age cutoff from the clock the caller passes', () => {
    const entries = normalizeCatalog(
      [
        languageModel({
          id: 'old/model',
          contextLength: 8000,
          releasedAt: OLDER_THAN_LIMIT_SECONDS,
        }),
        languageModel({ id: 'new/model', contextLength: 128_000 }),
      ],
      new Set(['old/model', 'new/model']),
      NOW_MS
    );

    expect(dispositions(entries)).toEqual([
      ['old/model', 'too-old'],
      ['new/model', 'normalized'],
    ]);
  });
});
