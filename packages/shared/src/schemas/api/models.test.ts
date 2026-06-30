import { describe, it, expect } from 'vitest';
import { modelSchema, type Model, modelCapabilitySchema } from './models.js';

describe('modelCapabilitySchema', () => {
  it('rejects invalid capabilities', () => {
    const result = modelCapabilitySchema.safeParse('invalid-capability');
    expect(result.success).toBe(false);
  });
});

describe('modelSchema', () => {
  it('parses a valid model object', () => {
    const validModel = {
      id: 'gpt-4-turbo',
      name: 'GPT-4 Turbo',
      provider: 'OpenAI',
      contextLength: 128_000,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_03,
      capabilities: [],
      description: 'A powerful language model from OpenAI.',
    };

    const result = modelSchema.safeParse(validModel);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        ...validModel,
        supportedParameters: [],
        modality: 'text',
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
      });
    }
  });

  it('parses a video model with pricePerSecondByResolution', () => {
    const videoModel = {
      id: 'google/veo-3.1-generate-001',
      name: 'Veo 3.1',
      provider: 'Google',
      modality: 'video',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: { '720p': 0.4, '1080p': 0.4 },
      capabilities: [],
      description: 'Video generation with audio',
    };
    const result = modelSchema.safeParse(videoModel);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pricePerSecondByResolution).toEqual({ '720p': 0.4, '1080p': 0.4 });
    }
  });

  it('preserves optional per-model capability sets when provided', () => {
    const veo31 = {
      id: 'google/veo-3.1-generate-001',
      name: 'Veo 3.1',
      provider: 'Google',
      modality: 'video',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: { '720p': 0.4, '1080p': 0.4, '4k': 0.6 },
      capabilities: [],
      description: 'Veo 3.1',
      supportedAspectRatios: ['16:9', '9:16'],
      supportedVideoResolutions: ['720p', '1080p', '4k'],
      supportedVideoDurationsSeconds: [4, 6, 8],
    };
    const result = modelSchema.safeParse(veo31);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supportedAspectRatios).toEqual(['16:9', '9:16']);
      expect(result.data.supportedVideoResolutions).toEqual(['720p', '1080p', '4k']);
      expect(result.data.supportedVideoDurationsSeconds).toEqual([4, 6, 8]);
    }
  });

  it('omits the capability fields when not declared (default-undefined)', () => {
    const minimal = {
      id: 'openai/gpt-5',
      name: 'GPT-5',
      provider: 'OpenAI',
      contextLength: 128_000,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_03,
      capabilities: [],
      description: 'Test model.',
    };
    const result = modelSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supportedAspectRatios).toBeUndefined();
      expect(result.data.supportedVideoResolutions).toBeUndefined();
      expect(result.data.supportedVideoDurationsSeconds).toBeUndefined();
    }
  });

  it('defaults pricePerSecondByResolution to empty object when absent', () => {
    const imageModel = {
      id: 'google/imagen-4.0-generate-001',
      name: 'Imagen 4',
      provider: 'Google',
      modality: 'image',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0.04,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'High-quality image generation',
    };
    const result = modelSchema.safeParse(imageModel);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pricePerSecondByResolution).toEqual({});
  });

  it('parses an audio model with pricePerSecond', () => {
    const audioModel = {
      id: 'openai/tts-1',
      name: 'TTS-1',
      provider: 'OpenAI',
      modality: 'audio',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0.015,
      capabilities: [],
      description: 'Text-to-speech audio generation',
    };
    const result = modelSchema.safeParse(audioModel);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pricePerSecond).toBeCloseTo(0.015, 6);
    }
  });

  it('defaults pricePerSecond to 0 when absent', () => {
    const imageModel = {
      id: 'google/imagen-4',
      name: 'Imagen 4',
      provider: 'Google',
      modality: 'image',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0.04,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'High-quality image generation',
    };
    const result = modelSchema.safeParse(imageModel);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pricePerSecond).toBe(0);
  });

  it('rejects pricePerSecond with a negative value', () => {
    const result = modelSchema.safeParse({
      id: 'x',
      name: 'X',
      provider: 'X',
      modality: 'audio',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: -0.01,
      capabilities: [],
      description: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects pricePerSecondByResolution with negative prices', () => {
    const result = modelSchema.safeParse({
      id: 'x',
      name: 'X',
      provider: 'X',
      modality: 'video',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: { '720p': -0.1 },
      capabilities: [],
      description: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('requires description field', () => {
    const modelWithoutDescription = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
    };

    const result = modelSchema.safeParse(modelWithoutDescription);
    expect(result.success).toBe(false);
  });

  it('requires all fields', () => {
    const incompleteModel = {
      id: 'gpt-4',
      name: 'GPT-4',
    };

    const result = modelSchema.safeParse(incompleteModel);
    expect(result.success).toBe(false);
  });

  it('validates contextLength is positive', () => {
    const invalidModel = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: -1,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(invalidModel);
    expect(result.success).toBe(false);
  });

  it('validates prices are non-negative', () => {
    const invalidModel = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: -0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(invalidModel);
    expect(result.success).toBe(false);
  });

  it('allows empty capabilities array', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
  });

  it('accepts optional created timestamp', () => {
    const modelWithCreated = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
      created: 1_704_067_200, // 2024-01-01
    };

    const result = modelSchema.safeParse(modelWithCreated);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created).toBe(1_704_067_200);
    }
  });

  it('allows model without created timestamp', () => {
    const modelWithoutCreated = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(modelWithoutCreated);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created).toBeUndefined();
    }
  });
});

describe('Model type', () => {
  it('infers correct type from schema', () => {
    const model: Model = {
      id: 'test-model',
      name: 'Test Model',
      provider: 'Test Provider',
      modality: 'text' as const,
      contextLength: 8192,
      pricePerInputToken: 0.0001,
      pricePerOutputToken: 0.0002,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'A test model for type inference.',
      supportedParameters: ['temperature'],
    };

    expect(model.id).toBe('test-model');
    expect(model.description).toBe('A test model for type inference.');
  });

  it('accepts optional isSmartModel flag', () => {
    const model = {
      id: 'smart-model',
      name: 'Smart Model',
      provider: 'HushBox',
      contextLength: 2_000_000,
      pricePerInputToken: 0.000_000_039,
      pricePerOutputToken: 0.000_000_19,
      capabilities: [],
      description: 'Uses the best model for your task',
      isSmartModel: true,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isSmartModel).toBe(true);
    }
  });

  it('defaults isSmartModel to undefined when omitted', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isSmartModel).toBeUndefined();
    }
  });

  it('accepts Smart Model price range fields', () => {
    const model = {
      id: 'smart-model',
      name: 'Smart Model',
      provider: 'HushBox',
      contextLength: 2_000_000,
      pricePerInputToken: 0.000_000_039,
      pricePerOutputToken: 0.000_000_19,
      capabilities: [],
      description: 'Uses the best model for your task',
      isSmartModel: true,
      minPricePerInputToken: 0.000_000_039,
      minPricePerOutputToken: 0.000_000_19,
      maxPricePerInputToken: 0.000_06,
      maxPricePerOutputToken: 0.000_18,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minPricePerInputToken).toBe(0.000_000_039);
      expect(result.data.maxPricePerOutputToken).toBe(0.000_18);
    }
  });

  it('rejects negative price range values', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
      minPricePerInputToken: -0.001,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(false);
  });
});

describe('modelSchema modality-specific validation', () => {
  // Refine guard rails — each modality has its own pricing field. Mismatches
  // are bugs (e.g., a text model accidentally getting per-image pricing from
  // the gateway) and the schema must catch them before the bad data leaks
  // into the UI or billing pipeline.

  it('rejects an image model that lacks pricePerImage > 0', () => {
    const result = modelSchema.safeParse({
      id: 'img/x',
      name: 'X',
      provider: 'Provider',
      modality: 'image',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'image with no per-image price',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an image model with per-token pricing set', () => {
    const result = modelSchema.safeParse({
      id: 'img/x',
      name: 'X',
      provider: 'Provider',
      modality: 'image',
      contextLength: 0,
      // image models must not carry token pricing — that's a text-modality field
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0,
      pricePerImage: 0.04,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'image with token pricing',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a video model with no pricePerSecondByResolution entries', () => {
    const result = modelSchema.safeParse({
      id: 'vid/x',
      name: 'X',
      provider: 'Provider',
      modality: 'video',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'video missing per-second-by-resolution',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a video model with per-image pricing set', () => {
    const result = modelSchema.safeParse({
      id: 'vid/x',
      name: 'X',
      provider: 'Provider',
      modality: 'video',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      // video must not carry image pricing
      pricePerImage: 0.04,
      pricePerSecondByResolution: { '720p': 0.4 },
      pricePerSecond: 0,
      capabilities: [],
      description: 'video with image pricing',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an audio model that lacks pricePerSecond > 0', () => {
    const result = modelSchema.safeParse({
      id: 'aud/x',
      name: 'X',
      provider: 'Provider',
      modality: 'audio',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'audio with no per-second price',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an audio model with pricePerSecondByResolution entries', () => {
    const result = modelSchema.safeParse({
      id: 'aud/x',
      name: 'X',
      provider: 'Provider',
      modality: 'audio',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      // audio is flat per-second, not per-resolution
      pricePerSecondByResolution: { '720p': 0.4 },
      pricePerSecond: 0.015,
      capabilities: [],
      description: 'audio with per-resolution pricing',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a text model with pricePerImage set', () => {
    const result = modelSchema.safeParse({
      id: 'txt/x',
      name: 'X',
      provider: 'Provider',
      modality: 'text',
      contextLength: 8192,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_03,
      pricePerImage: 0.04,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'text with per-image pricing',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a text model with pricePerSecond set', () => {
    const result = modelSchema.safeParse({
      id: 'txt/x',
      name: 'X',
      provider: 'Provider',
      modality: 'text',
      contextLength: 8192,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_03,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0.015,
      capabilities: [],
      description: 'text with per-second pricing',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid image model', () => {
    const result = modelSchema.safeParse({
      id: 'img/imagen-4',
      name: 'Imagen 4',
      provider: 'Google',
      modality: 'image',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0.04,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      description: 'High-quality image generation',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid video model', () => {
    const result = modelSchema.safeParse({
      id: 'vid/veo',
      name: 'Veo 3',
      provider: 'Google',
      modality: 'video',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: { '720p': 0.4, '1080p': 0.4 },
      pricePerSecond: 0,
      capabilities: [],
      description: 'Video generation',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid audio model', () => {
    const result = modelSchema.safeParse({
      id: 'aud/tts-1',
      name: 'TTS-1',
      provider: 'OpenAI',
      modality: 'audio',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0.015,
      capabilities: [],
      description: 'Text-to-speech audio',
    });
    expect(result.success).toBe(true);
  });

  // Characterization of the remaining per-modality guard rails: every
  // cross-modality pricing field combination must be rejected, each one
  // flagging the offending field in the issue path.

  it('rejects a text model with pricePerSecondByResolution entries', () => {
    const result = modelSchema.safeParse({
      id: 'text/x',
      name: 'X',
      provider: 'Provider',
      modality: 'text',
      contextLength: 8192,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_03,
      pricePerImage: 0,
      pricePerSecondByResolution: { '720p': 0.4 },
      pricePerSecond: 0,
      capabilities: [],
      description: 'text with resolution pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricePerSecondByResolution']);
  });

  it('rejects an image model with pricePerSecond set', () => {
    const result = modelSchema.safeParse({
      id: 'img/x',
      name: 'X',
      provider: 'Provider',
      modality: 'image',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0.04,
      pricePerSecondByResolution: {},
      pricePerSecond: 0.015,
      capabilities: [],
      description: 'image with per-second pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricePerSecond']);
  });

  it('rejects an image model with pricePerSecondByResolution entries', () => {
    const result = modelSchema.safeParse({
      id: 'img/x',
      name: 'X',
      provider: 'Provider',
      modality: 'image',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0.04,
      pricePerSecondByResolution: { '720p': 0.4 },
      pricePerSecond: 0,
      capabilities: [],
      description: 'image with resolution pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricePerSecondByResolution']);
  });

  it('rejects a video model with per-token pricing set', () => {
    const result = modelSchema.safeParse({
      id: 'vid/x',
      name: 'X',
      provider: 'Provider',
      modality: 'video',
      contextLength: 0,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: { '720p': 0.4 },
      pricePerSecond: 0,
      capabilities: [],
      description: 'video with token pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricePerInputToken']);
  });

  it('rejects a video model with flat pricePerSecond set', () => {
    const result = modelSchema.safeParse({
      id: 'vid/x',
      name: 'X',
      provider: 'Provider',
      modality: 'video',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: { '720p': 0.4 },
      pricePerSecond: 0.015,
      capabilities: [],
      description: 'video with flat per-second pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricePerSecond']);
  });

  it('rejects an audio model with per-token pricing set', () => {
    const result = modelSchema.safeParse({
      id: 'aud/x',
      name: 'X',
      provider: 'Provider',
      modality: 'audio',
      contextLength: 0,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0.015,
      capabilities: [],
      description: 'audio with token pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricePerInputToken']);
  });

  it('rejects an audio model with pricePerImage set', () => {
    const result = modelSchema.safeParse({
      id: 'aud/x',
      name: 'X',
      provider: 'Provider',
      modality: 'audio',
      contextLength: 0,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0.04,
      pricePerSecondByResolution: {},
      pricePerSecond: 0.015,
      capabilities: [],
      description: 'audio with per-image pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricePerImage']);
  });
});
