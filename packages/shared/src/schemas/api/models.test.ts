import { describe, it, expect } from 'vitest';
import {
  modelSchema,
  type Model,
  modelCapabilitySchema,
  wireModelPricingSchema,
} from './models.js';

describe('modelCapabilitySchema', () => {
  it('rejects invalid capabilities', () => {
    const result = modelCapabilitySchema.safeParse('invalid-capability');
    expect(result.success).toBe(false);
  });
});

describe('wireModelPricingSchema', () => {
  it('parses nano-USD string rates for a language model', () => {
    const result = wireModelPricingSchema.safeParse({
      inputPerToken: '3000',
      outputPerToken: '6000',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ inputPerToken: '3000', outputPerToken: '6000' });
    }
  });

  it('parses a per-resolution nano rate matrix', () => {
    const result = wireModelPricingSchema.safeParse({
      perSecondByResolution: { '720p': '100000000', '1080p': '200000000' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.perSecondByResolution).toEqual({
        '720p': '100000000',
        '1080p': '200000000',
      });
    }
  });

  it('accepts an empty pricing object (every rate optional)', () => {
    const result = wireModelPricingSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects a non-string rate (money never crosses JSON as a number)', () => {
    const result = wireModelPricingSchema.safeParse({ inputPerToken: 3000 });
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
      pricing: { inputPerToken: '10000', outputPerToken: '30000' },
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
      });
    }
  });

  it('parses a video model with a per-resolution nano matrix', () => {
    const videoModel = {
      id: 'google/veo-3.1-generate-001',
      name: 'Veo 3.1',
      provider: 'Google',
      modality: 'video',
      contextLength: 0,
      pricing: { perSecondByResolution: { '720p': '400000000', '1080p': '400000000' } },
      capabilities: [],
      description: 'Video generation with audio',
    };
    const result = modelSchema.safeParse(videoModel);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pricing.perSecondByResolution).toEqual({
        '720p': '400000000',
        '1080p': '400000000',
      });
    }
  });

  it('preserves optional per-model capability sets when provided', () => {
    const veo31 = {
      id: 'google/veo-3.1-generate-001',
      name: 'Veo 3.1',
      provider: 'Google',
      modality: 'video',
      contextLength: 0,
      pricing: {
        perSecondByResolution: { '720p': '400000000', '1080p': '400000000', '4k': '600000000' },
      },
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
      pricing: { inputPerToken: '10000', outputPerToken: '30000' },
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

  it('defaults pricing to an empty object when absent', () => {
    const imageModel = {
      id: 'google/imagen-4.0-generate-001',
      name: 'Imagen 4',
      provider: 'Google',
      modality: 'image',
      contextLength: 0,
      pricing: { perImage: '40000000' },
      capabilities: [],
      description: 'High-quality image generation',
    };
    const result = modelSchema.safeParse(imageModel);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pricing).toEqual({ perImage: '40000000' });
  });

  it('rejects a per-resolution rate with a non-string value', () => {
    const result = modelSchema.safeParse({
      id: 'x',
      name: 'X',
      provider: 'X',
      modality: 'video',
      contextLength: 0,
      pricing: { perSecondByResolution: { '720p': 400_000_000 } },
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
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
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
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
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
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
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
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
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
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(modelWithoutCreated);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created).toBeUndefined();
    }
  });

  it('accepts and preserves an optional popularityRank', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
      capabilities: [],
      description: 'Test description.',
      popularityRank: 3,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.popularityRank).toBe(3);
    }
  });

  it('leaves popularityRank undefined when omitted (never materialized)', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.popularityRank).toBeUndefined();
    }
  });

  it('rejects a negative popularityRank', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
      capabilities: [],
      description: 'Test description.',
      popularityRank: -1,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer popularityRank', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
      capabilities: [],
      description: 'Test description.',
      popularityRank: 1.5,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(false);
  });

  it('preserves the optional structured reasoning object', () => {
    const model = {
      id: 'openai/gpt-5',
      name: 'GPT-5',
      provider: 'OpenAI',
      contextLength: 400_000,
      pricing: { inputPerToken: '10000', outputPerToken: '30000' },
      capabilities: [],
      description: 'A reasoning model.',
      reasoning: {
        mandatory: true,
        supportedEfforts: ['high', 'medium', 'low', 'minimal'],
        defaultEffort: 'medium',
        defaultEnabled: true,
      },
    };
    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoning).toEqual({
        mandatory: true,
        supportedEfforts: ['high', 'medium', 'low', 'minimal'],
        defaultEffort: 'medium',
        defaultEnabled: true,
      });
    }
  });

  it('leaves reasoning absent when not declared (backward-compatible wire rows)', () => {
    const result = modelSchema.safeParse({
      id: 'plain/model',
      name: 'Plain',
      provider: 'Test',
      contextLength: 8192,
      pricing: { inputPerToken: '100', outputPerToken: '200' },
      capabilities: [],
      description: 'No reasoning object.',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reasoning).toBeUndefined();
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
      pricing: { inputPerToken: '100000', outputPerToken: '200000' },
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
      pricing: { inputPerToken: '39', outputPerToken: '190' },
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
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isSmartModel).toBeUndefined();
    }
  });

  it('accepts Smart Model nano min/max pricing range fields', () => {
    const model = {
      id: 'smart-model',
      name: 'Smart Model',
      provider: 'HushBox',
      contextLength: 2_000_000,
      pricing: { inputPerToken: '39', outputPerToken: '190' },
      capabilities: [],
      description: 'Uses the best model for your task',
      isSmartModel: true,
      minPricing: { inputPerToken: '39', outputPerToken: '190' },
      maxPricing: { inputPerToken: '60000', outputPerToken: '180000' },
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minPricing?.inputPerToken).toBe('39');
      expect(result.data.maxPricing?.outputPerToken).toBe('180000');
    }
  });

  it('rejects a non-string min/max range value', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricing: { inputPerToken: '1000000', outputPerToken: '2000000' },
      capabilities: [],
      description: 'Test description.',
      minPricing: { inputPerToken: 1000 },
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(false);
  });
});

describe('modelSchema modality-specific validation', () => {
  // Refine guard rails — each modality owns one pricing dimension on the nested
  // `pricing` object. Mismatches are bugs (e.g., a text model accidentally
  // getting per-image pricing from the gateway) and the schema must catch them
  // before the bad data leaks into the UI or billing pipeline. Issue paths
  // point at ['pricing', <rate>].

  it('rejects an image model that lacks a positive perImage rate', () => {
    const result = modelSchema.safeParse({
      id: 'img/x',
      name: 'X',
      provider: 'Provider',
      modality: 'image',
      contextLength: 0,
      pricing: { perImage: '0' },
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
      pricing: { inputPerToken: '10000', perImage: '40000000' },
      capabilities: [],
      description: 'image with token pricing',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a video model with no per-resolution entries', () => {
    const result = modelSchema.safeParse({
      id: 'vid/x',
      name: 'X',
      provider: 'Provider',
      modality: 'video',
      contextLength: 0,
      pricing: {},
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
      // video must not carry image pricing
      pricing: { perImage: '40000000', perSecondByResolution: { '720p': '400000000' } },
      capabilities: [],
      description: 'video with image pricing',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a text model with per-image pricing set', () => {
    const result = modelSchema.safeParse({
      id: 'txt/x',
      name: 'X',
      provider: 'Provider',
      modality: 'text',
      contextLength: 8192,
      pricing: { inputPerToken: '10000', outputPerToken: '30000', perImage: '40000000' },
      capabilities: [],
      description: 'text with per-image pricing',
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
      pricing: { perImage: '40000000' },
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
      pricing: { perSecondByResolution: { '720p': '400000000', '1080p': '400000000' } },
      capabilities: [],
      description: 'Video generation',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a text model with per-resolution entries and flags the field', () => {
    const result = modelSchema.safeParse({
      id: 'text/x',
      name: 'X',
      provider: 'Provider',
      modality: 'text',
      contextLength: 8192,
      pricing: {
        inputPerToken: '10000',
        outputPerToken: '30000',
        perSecondByResolution: { '720p': '400000000' },
      },
      capabilities: [],
      description: 'text with resolution pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricing', 'perSecondByResolution']);
  });

  it('rejects an image model with per-resolution entries and flags the field', () => {
    const result = modelSchema.safeParse({
      id: 'img/x',
      name: 'X',
      provider: 'Provider',
      modality: 'image',
      contextLength: 0,
      pricing: { perImage: '40000000', perSecondByResolution: { '720p': '400000000' } },
      capabilities: [],
      description: 'image with resolution pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricing', 'perSecondByResolution']);
  });

  it('rejects a video model with per-token pricing set and flags the field', () => {
    const result = modelSchema.safeParse({
      id: 'vid/x',
      name: 'X',
      provider: 'Provider',
      modality: 'video',
      contextLength: 0,
      pricing: { inputPerToken: '10000', perSecondByResolution: { '720p': '400000000' } },
      capabilities: [],
      description: 'video with token pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricing', 'inputPerToken']);
  });

  it('rejects an audio model with per-token pricing set', () => {
    const result = modelSchema.safeParse({
      id: 'aud/x',
      name: 'X',
      provider: 'Provider',
      modality: 'audio',
      contextLength: 0,
      pricing: { inputPerToken: '10000' },
      capabilities: [],
      description: 'audio with token pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricing', 'inputPerToken']);
  });

  it('rejects an audio model with per-image pricing set', () => {
    const result = modelSchema.safeParse({
      id: 'aud/x',
      name: 'X',
      provider: 'Provider',
      modality: 'audio',
      contextLength: 0,
      pricing: { perImage: '40000000' },
      capabilities: [],
      description: 'audio with per-image pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricing', 'perImage']);
  });

  it('rejects an audio model with per-resolution entries and flags the field', () => {
    const result = modelSchema.safeParse({
      id: 'aud/x',
      name: 'X',
      provider: 'Provider',
      modality: 'audio',
      contextLength: 0,
      pricing: { perSecondByResolution: { '720p': '400000000' } },
      capabilities: [],
      description: 'audio with per-resolution pricing',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['pricing', 'perSecondByResolution']);
  });
});
