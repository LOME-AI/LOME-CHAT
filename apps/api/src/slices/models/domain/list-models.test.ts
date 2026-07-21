import { describe, expect, it } from 'vitest';
import { SMART_MODEL_ID, modelsListResponseSchema, nanoUSD } from '@hushbox/shared';
import { buildModelsListResponse } from './list-models.js';
import type { Modality, ModelDescriptor, Pricing } from '@hushbox/shared';

// A fixed reference clock; recency is judged against it, not the wall clock.
const NOW_MS = 1_800_000_000_000;
// releasedAt (unix SECONDS) whose *1000 sits well before NOW - 182 days.
const OLD_RELEASE = 1_600_000_000;
// releasedAt whose *1000 sits within the last 182 days of NOW.
const RECENT_RELEASE = 1_790_000_000;

function tokenPricing(inputPerToken: bigint, outputPerToken: bigint): Pricing {
  return { inputPerToken: nanoUSD(inputPerToken), outputPerToken: nanoUSD(outputPerToken) };
}

function textModel(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'test/text-model',
    provider: 'test',
    version: '1',
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: 128_000 },
    pricing: tokenPricing(3000n, 6000n),
    zdrReachable: true,
    releasedAt: OLD_RELEASE,
    fetchedAt: 0,
    ...overrides,
  };
}

function imageModel(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return textModel({
    id: 'test/image-model',
    outputs: ['image'] as Modality[],
    behaviors: [],
    limits: {},
    pricing: { perImage: nanoUSD(40_000_000n) },
    parameters: {
      aspectRatio: { type: 'enum', values: ['1:1', '16:9'], wire: 'providerOptions' },
    },
    ...overrides,
  });
}

function videoModel(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return textModel({
    id: 'test/video-model',
    outputs: ['video'] as Modality[],
    behaviors: [],
    limits: {},
    pricing: {
      perSecondByResolution: {
        '720p': nanoUSD(100_000_000n),
        '1080p': nanoUSD(200_000_000n),
      },
    },
    parameters: {
      resolution: { type: 'enum', values: ['720p', '1080p'], wire: 'providerOptions' },
      aspectRatio: { type: 'enum', values: ['16:9', '9:16'], wire: 'providerOptions' },
      duration: { type: 'enum', values: [4, 6, 8], wire: 'providerOptions' },
    },
    ...overrides,
  });
}

/** Cheap-to-expensive old text models feeding the premium price percentile. */
function priceSpread(prices: readonly bigint[]): ModelDescriptor[] {
  return prices.map((combined, index) =>
    textModel({ id: `spread/${String(index)}`, pricing: tokenPricing(combined, 0n) })
  );
}

describe('buildModelsListResponse', () => {
  it('projects a text descriptor into the shared Model shape with BASE nano pricing', () => {
    const descriptor = textModel({ name: 'Testy: Text Model', description: 'A test model.' });
    const { response } = buildModelsListResponse([descriptor], NOW_MS);
    const model = response.models.find((entry) => entry.id === descriptor.id);
    expect(model).toBeDefined();
    expect(model).toMatchObject({
      name: 'Text Model',
      provider: 'Testy',
      modality: 'text',
      contextLength: 128_000,
      description: 'A test model.',
      created: OLD_RELEASE,
    });
    // BASE nano rates, verbatim from the descriptor — no fee, no markup.
    expect(model?.pricing.inputPerToken).toBe('3000');
    expect(model?.pricing.outputPerToken).toBe('6000');
    expect(model?.pricing.perImage).toBeUndefined();
  });

  it('parses against the shared modelsListResponseSchema wire contract', () => {
    const { response } = buildModelsListResponse([textModel(), imageModel(), videoModel()], NOW_MS);
    expect(() => modelsListResponseSchema.parse(response)).not.toThrow();
  });

  it('falls back to the descriptor provider slug and id when no display name exists', () => {
    const descriptor = textModel({ id: 'test/no-name' });
    const { response } = buildModelsListResponse([descriptor], NOW_MS);
    const model = response.models.find((entry) => entry.id === descriptor.id);
    expect(model?.provider).toBe('test');
    expect(model?.name).toBe('test/no-name');
  });

  it('marks the top price quartile of old, affordable text models premium', () => {
    const catalog = priceSpread([10n, 20n, 30n, 40n, 50n]);
    const { response } = buildModelsListResponse(catalog, NOW_MS);
    // Threshold = combined price at floor(5 * 0.75) = index 3 of the ascending
    // sort — models at or above it (40n, 50n) are premium; the rest are not.
    expect(response.premiumModelIds).toContain('spread/3');
    expect(response.premiumModelIds).toContain('spread/4');
    expect(response.premiumModelIds).not.toContain('spread/0');
    expect(response.premiumModelIds).not.toContain('spread/1');
    expect(response.premiumModelIds).not.toContain('spread/2');
  });

  it('marks a recently released text model premium regardless of price', () => {
    const recent = textModel({
      id: 'test/recent',
      releasedAt: RECENT_RELEASE,
      pricing: tokenPricing(1n, 1n),
    });
    const catalog = [...priceSpread([10n, 20n, 30n, 40n, 50n]), recent];
    const { response } = buildModelsListResponse(catalog, NOW_MS);
    expect(response.premiumModelIds).toContain('test/recent');
  });

  it('marks every media model premium', () => {
    // 100n/200n per token keeps the text model under the trial affordability
    // cap, so only the media models are classified premium here.
    const cheapText = textModel({ pricing: tokenPricing(100n, 200n) });
    const { response } = buildModelsListResponse([cheapText, imageModel(), videoModel()], NOW_MS);
    expect(response.premiumModelIds).toContain('test/image-model');
    expect(response.premiumModelIds).toContain('test/video-model');
    expect(response.premiumModelIds).not.toContain('test/text-model');
  });

  it('projects an image descriptor with per-image pricing and aspect ratios', () => {
    const { response } = buildModelsListResponse([imageModel()], NOW_MS);
    const model = response.models.find((entry) => entry.id === 'test/image-model');
    expect(model?.modality).toBe('image');
    expect(model?.pricing.perImage).toBe('40000000');
    expect(model?.pricing.inputPerToken).toBeUndefined();
    expect(model?.supportedAspectRatios).toEqual(['1:1', '16:9']);
  });

  it('projects a video descriptor with per-resolution pricing and capability lists', () => {
    const { response } = buildModelsListResponse([videoModel()], NOW_MS);
    const model = response.models.find((entry) => entry.id === 'test/video-model');
    expect(model?.modality).toBe('video');
    expect(model?.pricing.perSecondByResolution?.['720p']).toBe('100000000');
    expect(model?.pricing.perSecondByResolution?.['1080p']).toBe('200000000');
    expect(model?.supportedVideoResolutions).toEqual(['720p', '1080p']);
    expect(model?.supportedAspectRatios).toEqual(['16:9', '9:16']);
    expect(model?.supportedVideoDurationsSeconds).toEqual([4, 6, 8]);
  });

  it('appends a synthetic Smart Model entry spanning the text pool price range', () => {
    const cheap = textModel({ id: 'test/cheap', pricing: tokenPricing(100n, 200n) });
    const dear = textModel({ id: 'test/dear', pricing: tokenPricing(1000n, 2000n) });
    const { response } = buildModelsListResponse([cheap, dear], NOW_MS);
    const smart = response.models.find((entry) => entry.id === SMART_MODEL_ID);
    expect(smart).toBeDefined();
    if (smart === undefined) return;
    expect(smart.isSmartModel).toBe(true);
    expect(smart.modality).toBe('text');
    // Headline pricing tracks the cheapest pool model; min/max carry the BASE
    // nano range (no fee, no markup).
    expect(smart.pricing.inputPerToken).toBe('100');
    expect(smart.minPricing).toEqual({ inputPerToken: '100', outputPerToken: '200' });
    expect(smart.maxPricing).toEqual({ inputPerToken: '1000', outputPerToken: '2000' });
    expect(response.premiumModelIds).not.toContain(SMART_MODEL_ID);
  });

  it('omits the Smart Model entry when no priceable text model exists', () => {
    const { response } = buildModelsListResponse([imageModel()], NOW_MS);
    expect(response.models.some((entry) => entry.id === SMART_MODEL_ID)).toBe(false);
  });

  it('maps a known provider slug through PROVIDER_MAP when the name has no colon', () => {
    const descriptor = textModel({ id: 'openai/gpt-test', provider: 'openai', name: 'GPT Test' });
    const { response } = buildModelsListResponse([descriptor], NOW_MS);
    const model = response.models.find((entry) => entry.id === descriptor.id);
    expect(model?.provider).toBe('OpenAI');
    expect(model?.name).toBe('GPT Test');
  });

  it('ignores a colon split that would leave an empty display name', () => {
    const descriptor = textModel({ id: 'test/trailing-colon', name: 'Weird:' });
    const { response } = buildModelsListResponse([descriptor], NOW_MS);
    const model = response.models.find((entry) => entry.id === descriptor.id);
    expect(model?.provider).toBe('test');
    expect(model?.name).toBe('Weird:');
  });

  it('drops a descriptor whose outputs match no listed family', () => {
    const audioOnly = textModel({ id: 'test/audio-only', outputs: ['audio'] as Modality[] });
    const { response, dropped } = buildModelsListResponse([audioOnly], NOW_MS);
    expect(dropped).toContain('test/audio-only');
    expect(response.models).toHaveLength(0);
  });

  it('drops an image descriptor without a per-image rate', () => {
    const unpriced = imageModel({ id: 'test/image-unpriced', pricing: {} });
    const { response, dropped } = buildModelsListResponse([unpriced], NOW_MS);
    expect(dropped).toContain('test/image-unpriced');
    expect(response.models).toHaveLength(0);
  });

  it('drops a video descriptor without per-resolution pricing', () => {
    const unpriced = videoModel({
      id: 'test/video-unpriced',
      pricing: { perSecond: nanoUSD(100n) },
    });
    const { dropped } = buildModelsListResponse([unpriced], NOW_MS);
    expect(dropped).toContain('test/video-unpriced');
  });

  it('omits video capability lists the descriptor parameters cannot supply', () => {
    const bare = videoModel({ id: 'test/video-bare', parameters: {} });
    const nonNumeric = videoModel({
      id: 'test/video-nonnumeric',
      parameters: { duration: { type: 'enum', values: ['4', 'fast'], wire: 'providerOptions' } },
    });
    const { response } = buildModelsListResponse([bare, nonNumeric], NOW_MS);
    const bareModel = response.models.find((entry) => entry.id === 'test/video-bare');
    expect(bareModel?.supportedVideoDurationsSeconds).toBeUndefined();
    expect(bareModel?.supportedVideoResolutions).toBeUndefined();
    const mixed = response.models.find((entry) => entry.id === 'test/video-nonnumeric');
    expect(mixed?.supportedVideoDurationsSeconds).toEqual([4]);
  });

  it('drops all-non-numeric video durations entirely', () => {
    const invalid = videoModel({
      id: 'test/video-bad-durations',
      parameters: { duration: { type: 'enum', values: ['fast'], wire: 'providerOptions' } },
    });
    const { response } = buildModelsListResponse([invalid], NOW_MS);
    const model = response.models.find((entry) => entry.id === 'test/video-bad-durations');
    expect(model?.supportedVideoDurationsSeconds).toBeUndefined();
  });

  it('drops the Smart Model entry when the text pool cannot satisfy the contract', () => {
    // Priceable text models without a context length: each is dropped itself,
    // and the synthetic entry (max context = 0) fails the text refine too.
    const noContext = textModel({ id: 'test/no-ctx-a', limits: {} });
    const noContextB = textModel({ id: 'test/no-ctx-b', limits: {} });
    const { response, dropped } = buildModelsListResponse([noContext, noContextB], NOW_MS);
    expect(dropped).toContain(SMART_MODEL_ID);
    expect(response.models).toHaveLength(0);
  });

  it('drops a text descriptor without a context length instead of failing the list', () => {
    const invalid = textModel({ id: 'test/no-context', limits: {} });
    const { response, dropped } = buildModelsListResponse([invalid, textModel()], NOW_MS);
    expect(dropped).toContain('test/no-context');
    expect(response.models.some((entry) => entry.id === 'test/no-context')).toBe(false);
    expect(response.models.some((entry) => entry.id === 'test/text-model')).toBe(true);
  });

  it('projects a defined popularityRank onto the wire model', () => {
    const descriptor = textModel({ id: 'test/ranked', popularityRank: 5 });
    const { response } = buildModelsListResponse([descriptor], NOW_MS);
    const model = response.models.find((entry) => entry.id === 'test/ranked');
    expect(model?.popularityRank).toBe(5);
  });

  it('omits popularityRank from the wire model when the descriptor carries none', () => {
    const { response } = buildModelsListResponse([textModel()], NOW_MS);
    const model = response.models.find((entry) => entry.id === 'test/text-model');
    expect(model).toBeDefined();
    expect(model !== undefined && 'popularityRank' in model).toBe(false);
  });
});
