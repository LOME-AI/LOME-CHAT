import { describe, it, expect } from 'vitest';
import type { Model } from '@hushbox/shared';
import type { RawModel } from '@hushbox/shared/models';
import { buildModelViewsForModality, toModelView } from './model-view.js';

function textModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'openai/gpt-5-nano',
    name: 'GPT-5 nano',
    provider: 'OpenAI',
    modality: 'text',
    description: 'Cheap text model',
    contextLength: 128_000,
    pricePerInputToken: 0.000_000_1,
    pricePerOutputToken: 0.000_000_4,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    supportedParameters: ['temperature', 'max_tokens'],
    created: 1_700_000_000,
    ...overrides,
  };
}

function imageModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'google/imagen-4.0-fast-generate-001',
    name: 'Imagen 4 fast',
    provider: 'Google',
    modality: 'image',
    description: 'Fast image model',
    contextLength: 0,
    pricePerInputToken: 0,
    pricePerOutputToken: 0,
    pricePerImage: 0.01,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    supportedParameters: [],
    ...overrides,
  };
}

function videoModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'google/veo-3.1-generate-001',
    name: 'Veo 3.1',
    provider: 'Google',
    modality: 'video',
    description: 'Video model',
    contextLength: 0,
    pricePerInputToken: 0,
    pricePerOutputToken: 0,
    pricePerImage: 0,
    pricePerSecondByResolution: { '720p': 0.4, '1080p': 0.4, '4k': 0.6 },
    pricePerSecond: 0,
    capabilities: [],
    supportedParameters: [],
    ...overrides,
  };
}

function audioModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'openai/tts-1',
    name: 'TTS-1',
    provider: 'OpenAI',
    modality: 'audio',
    description: 'TTS model',
    contextLength: 0,
    pricePerInputToken: 0,
    pricePerOutputToken: 0,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0.015,
    capabilities: [],
    supportedParameters: [],
    ...overrides,
  };
}

describe('toModelView — text', () => {
  it('returns a TextModelView with flat pricing fields', () => {
    const view = toModelView(textModel(), false);
    expect(view.modality).toBe('text');
    if (view.modality !== 'text') throw new Error('discriminator narrows');
    expect(view.id).toBe('openai/gpt-5-nano');
    expect(view.name).toBe('GPT-5 nano');
    expect(view.provider).toBe('OpenAI');
    expect(view.contextLength).toBe(128_000);
    expect(view.inputPerToken).toBe(0.000_000_1);
    expect(view.outputPerToken).toBe(0.000_000_4);
  });

  it('propagates isPremium through', () => {
    expect(toModelView(textModel(), true).isPremium).toBe(true);
    expect(toModelView(textModel(), false).isPremium).toBe(false);
  });

  it('omits created when undefined on source', () => {
    const view = toModelView(textModel({ created: undefined }), false);
    expect('created' in view).toBe(false);
  });

  it('includes vision feature for models with no special supportedParameters', () => {
    const view = toModelView(textModel(), false);
    expect(view.features).toContain('vision');
  });

  it('includes code-execution features for tools-capable models', () => {
    const view = toModelView(textModel({ supportedParameters: ['tools'] }), false);
    expect(view.features).toContain('python-execution');
    expect(view.features).toContain('javascript-execution');
  });
});

describe('toModelView — image', () => {
  it('returns ImageModelView with flat perImage pricing', () => {
    const view = toModelView(imageModel(), false);
    expect(view.modality).toBe('image');
    if (view.modality !== 'image') throw new Error('discriminator narrows');
    expect(view.perImage).toBe(0.01);
  });

  it('populates supportedAspectRatios and imagenSampleSize for Imagen-4 models', () => {
    const view = toModelView(imageModel({ id: 'google/imagen-4.0-fast-generate-001' }), false);
    if (view.modality !== 'image') throw new Error('discriminator');
    expect(view.supportedAspectRatios).toEqual(['1:1', '4:3', '3:4', '16:9', '9:16']);
    expect(view.imagenSampleSize).toBe('1K');
  });

  it("sets imagenSampleSize='2K' for Imagen-4 generate variant", () => {
    const view = toModelView(imageModel({ id: 'google/imagen-4.0-generate-001' }), false);
    if (view.modality !== 'image') throw new Error('discriminator');
    expect(view.imagenSampleSize).toBe('2K');
  });

  it('omits capability fields when model lacks Imagen capability data', () => {
    const view = toModelView(imageModel({ id: 'google/gemini-2.5-flash-image' }), false);
    if (view.modality !== 'image') throw new Error('discriminator');
    expect('supportedAspectRatios' in view).toBe(false);
    expect('imagenSampleSize' in view).toBe(false);
  });
});

describe('toModelView — video', () => {
  it('returns VideoModelView with perSecondByResolution', () => {
    const view = toModelView(videoModel(), false);
    expect(view.modality).toBe('video');
    if (view.modality !== 'video') throw new Error('discriminator narrows');
    expect(view.perSecondByResolution).toEqual({ '720p': 0.4, '1080p': 0.4, '4k': 0.6 });
  });

  it('populates Veo 3.1 capability axes', () => {
    const view = toModelView(videoModel({ id: 'google/veo-3.1-generate-001' }), true);
    if (view.modality !== 'video') throw new Error('discriminator');
    expect(view.supportedAspectRatios).toEqual(['16:9', '9:16']);
    expect(view.supportedResolutions).toEqual(['720p', '1080p', '4k']);
    expect(view.supportedDurationsSeconds).toEqual([4, 6, 8]);
  });

  it('populates Veo 3.0 capability axes (no 4k, shares 3.1 durations)', () => {
    const view = toModelView(videoModel({ id: 'google/veo-3.0-generate-001' }), false);
    if (view.modality !== 'video') throw new Error('discriminator');
    expect(view.supportedResolutions).toEqual(['720p', '1080p']);
    expect(view.supportedDurationsSeconds).toEqual([4, 6, 8]);
  });

  it('omits capability fields for unknown video model', () => {
    const view = toModelView(videoModel({ id: 'unknown/video' }), false);
    if (view.modality !== 'video') throw new Error('discriminator');
    expect('supportedAspectRatios' in view).toBe(false);
    expect('supportedResolutions' in view).toBe(false);
    expect('supportedDurationsSeconds' in view).toBe(false);
  });
});

describe('toModelView — audio', () => {
  it('returns AudioModelView with flat perSecond pricing', () => {
    const view = toModelView(audioModel(), false);
    expect(view.modality).toBe('audio');
    if (view.modality !== 'audio') throw new Error('discriminator narrows');
    expect(view.perSecond).toBe(0.015);
  });
});

function rawText(
  id: string,
  promptPrice = '0.0001',
  completionPrice = '0.0004',
  ageMonths = 12
): RawModel {
  return {
    id,
    name: id,
    description: 'text model',
    modality: 'text',
    context_length: 200_000,
    pricing: { prompt: promptPrice, completion: completionPrice },
    supported_parameters: ['tools'],
    // Subtract months so the model is past PREMIUM_RECENCY_MS (~6 months);
    // otherwise the recency rule alone marks every model as premium.
    created: Math.floor((Date.now() - ageMonths * 30 * 24 * 60 * 60 * 1000) / 1000),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  };
}

function rawVideo(id: string): RawModel {
  return {
    id,
    name: id,
    description: 'video model',
    modality: 'video',
    context_length: 0,
    pricing: {
      prompt: '0',
      completion: '0',
      per_second_by_resolution: { '720p': '0.4', '1080p': '0.4' },
    },
    supported_parameters: [],
    created: Math.floor(Date.now() / 1000),
    architecture: { input_modalities: ['video'], output_modalities: ['video'] },
  };
}

describe('buildModelViewsForModality', () => {
  it('returns only models of the requested modality', () => {
    const raws: RawModel[] = [
      rawText('openai/gpt-5-nano'),
      rawText('anthropic/claude-haiku-4.5'),
      rawVideo('google/veo-3.1-generate-001'),
    ];
    const text = buildModelViewsForModality(raws, 'text');
    const video = buildModelViewsForModality(raws, 'video');
    expect(text.map((m) => m.id)).toContain('openai/gpt-5-nano');
    expect(text.map((m) => m.id)).not.toContain('google/veo-3.1-generate-001');
    expect(video.map((m) => m.id)).toContain('google/veo-3.1-generate-001');
    expect(video.map((m) => m.id)).not.toContain('openai/gpt-5-nano');
  });

  it('excludes the synthetic Smart Model entry from text results', () => {
    const text = buildModelViewsForModality([rawText('openai/gpt-5-nano')], 'text');
    expect(text.find((m) => m.id === 'smart-model')).toBeUndefined();
  });

  it('marks expensive recent models as premium via isPremium', () => {
    // String prices: no JS numeric underscores (parseFloat stops at '_').
    const raws: RawModel[] = [
      rawText('openai/gpt-5-nano', '0.0000001', '0.0000004'),
      rawText('anthropic/claude-opus-4.6', '0.000015', '0.000075'),
    ];
    const text = buildModelViewsForModality(raws, 'text');
    const opus = text.find((m) => m.id === 'anthropic/claude-opus-4.6');
    const nano = text.find((m) => m.id === 'openai/gpt-5-nano');
    expect(opus?.isPremium).toBe(true);
    expect(nano?.isPremium).toBe(false);
  });

  it('excludes non-ZDR catalog entries (raw → processed filter)', () => {
    const raws: RawModel[] = [rawText('openai/gpt-5-nano'), rawText('not-on-zdr/model')];
    const text = buildModelViewsForModality(raws, 'text');
    expect(text.map((m) => m.id)).not.toContain('not-on-zdr/model');
  });
});
