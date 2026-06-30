import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Override ZDR to allow all models in this test — this isolates processing logic
// (free-model filter, name patterns, age, premium classification) from ZDR concerns,
// which are tested separately in zdr.test.ts.
vi.mock('./zdr.js', () => ({
  isZdrModel: () => true,
}));

import { processModels, pickValueTextModel, pickValueTextModels } from './process-models.js';
import { SMART_MODEL_ID } from '../constants.js';
import { applyFees } from '../pricing.js';

/**
 * Strip the synthetic Smart Model entry so tests can assert against only
 * the real gateway models. Smart Model injection is covered in its own describe.
 */
function realModelIds(result: ReturnType<typeof processModels>): string[] {
  return result.models.filter((m) => m.id !== SMART_MODEL_ID).map((m) => m.id);
}

const now = Date.now();
const twoYearsAgo = now - 2 * 365 * 24 * 60 * 60 * 1000;
const threeYearsAgo = now - 3 * 365 * 24 * 60 * 60 * 1000;

function createModel(overrides: Partial<Parameters<typeof processModels>[0][0]> = {}) {
  return {
    id: 'test/model',
    name: 'Test Model',
    description: 'A test model',
    modality: 'text' as const,
    context_length: 100_000,
    pricing: { prompt: '0.001', completion: '0.002' },
    supported_parameters: ['temperature'],
    created: Math.floor(now / 1000),
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
    ...overrides,
  };
}

function createImageModel(overrides: Partial<Parameters<typeof processModels>[0][0]> = {}) {
  return createModel({
    id: 'google/imagen-4.0-generate-001',
    name: 'Imagen 4',
    modality: 'image',
    context_length: 0,
    pricing: { prompt: '0', completion: '0', per_image: '0.04' },
    architecture: { input_modalities: ['image'], output_modalities: ['image'] },
    ...overrides,
  });
}

function createVideoModel(overrides: Partial<Parameters<typeof processModels>[0][0]> = {}) {
  return createModel({
    id: 'google/veo-3.1-generate-001',
    name: 'Veo 3.1',
    modality: 'video',
    context_length: 0,
    pricing: {
      prompt: '0',
      completion: '0',
      per_second_by_resolution: { '720p': '0.4', '1080p': '0.4' },
    },
    architecture: { input_modalities: ['video'], output_modalities: ['video'] },
    ...overrides,
  });
}

function createAudioModel(overrides: Partial<Parameters<typeof processModels>[0][0]> = {}) {
  return createModel({
    id: 'openai/tts-1',
    name: 'TTS-1',
    modality: 'audio',
    context_length: 0,
    pricing: { prompt: '0', completion: '0', per_second: '0.015' },
    architecture: { input_modalities: ['text'], output_modalities: ['audio'] },
    ...overrides,
  });
}

describe('processModels', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('filtering - always excluded', () => {
    it('excludes free models (both prices = 0)', () => {
      const models = [
        createModel({ id: 'paid/model' }),
        createModel({ id: 'free/model', pricing: { prompt: '0', completion: '0' } }),
      ];

      const result = processModels(models);

      expect(realModelIds(result)).toEqual(['paid/model']);
    });

    it('excludes Body Builder models', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'utility/builder', name: 'Body Builder (beta)' }),
      ];

      const result = processModels(models);

      expect(realModelIds(result)).toEqual(['normal/model']);
    });

    it('excludes Auto Router models', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'utility/router', name: 'Auto Router' }),
      ];

      const result = processModels(models);

      expect(realModelIds(result)).toEqual(['normal/model']);
    });

    it('excludes models with audio in name', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'openai/gpt-audio', name: 'GPT Audio' }),
        createModel({ id: 'openai/audio-preview', name: 'OpenAI: Audio Preview' }),
      ];

      const result = processModels(models);

      expect(realModelIds(result)).toEqual(['normal/model']);
    });

    it('excludes models with image in name', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'openai/gpt-image', name: 'GPT Image' }),
        createModel({ id: 'openai/image-gen', name: 'OpenAI: Image Generator' }),
      ];

      const result = processModels(models);

      expect(realModelIds(result)).toEqual(['normal/model']);
    });

    it('excludes models without text in input_modalities', () => {
      const models = [
        createModel({ id: 'text/model' }),
        createModel({
          id: 'image-only/model',
          architecture: { input_modalities: ['image'], output_modalities: ['text'] },
        }),
      ];

      const result = processModels(models);

      expect(realModelIds(result)).toEqual(['text/model']);
    });

    it('excludes models without text in output_modalities', () => {
      const models = [
        createModel({ id: 'text/model' }),
        createModel({
          id: 'embedding/model',
          architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] },
        }),
      ];

      const result = processModels(models);

      expect(realModelIds(result)).toEqual(['text/model']);
    });

    it('includes multimodal models with text input and output', () => {
      const models = [
        createModel({
          id: 'vision/model',
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        }),
      ];

      const result = processModels(models);

      expect(realModelIds(result)).toEqual(['vision/model']);
    });

    it('applies name pattern matching case-insensitively', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'utility/1', name: 'BODY BUILDER' }),
        createModel({ id: 'utility/2', name: 'auto router' }),
      ];

      const result = processModels(models);

      expect(realModelIds(result)).toEqual(['normal/model']);
    });
  });

  describe('filtering - standard criteria (bypassable)', () => {
    it('excludes models older than 2 years', () => {
      const models = Array.from({ length: 20 }, (_, index) =>
        createModel({
          id: `recent/model-${String(index)}`,
          context_length: 200_000,
          created: Math.floor(now / 1000),
        })
      );
      // Add old model with lower context (won't be in top 5%)
      models.push(
        createModel({
          id: 'old/model',
          context_length: 50_000,
          created: Math.floor(threeYearsAgo / 1000),
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain('old/model');
    });

    it('includes models at exactly 2 years old', () => {
      const models = [
        createModel({ id: 'boundary/model', created: Math.floor(twoYearsAgo / 1000) }),
      ];

      const result = processModels(models);

      expect(realModelIds(result)).toEqual(['boundary/model']);
    });

    it('excludes models cheaper than $0.0002 per 1K tokens combined', () => {
      const models = Array.from({ length: 20 }, (_, index) =>
        createModel({
          id: `expensive/model-${String(index)}`,
          context_length: 200_000,
          pricing: { prompt: '0.001', completion: '0.001' },
        })
      );
      models.push(
        createModel({
          id: 'cheap/model',
          context_length: 50_000,
          pricing: { prompt: '0.0000001', completion: '0.0000001' },
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain('cheap/model');
    });
  });

  describe('filtering - top 5% context bypass', () => {
    it('includes old models if in top 5% context size', () => {
      const models = Array.from({ length: 99 }, (_, index) =>
        createModel({
          id: `normal/model-${String(index)}`,
          context_length: 100_000,
          created: Math.floor(now / 1000),
        })
      );
      models.push(
        createModel({
          id: 'old-but-large-context/model',
          context_length: 2_000_000, // Much larger than others
          created: Math.floor(threeYearsAgo / 1000),
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toContain('old-but-large-context/model');
    });

    it('includes cheap models if in top 5% context size', () => {
      const models = Array.from({ length: 99 }, (_, index) =>
        createModel({
          id: `normal/model-${String(index)}`,
          context_length: 100_000,
          pricing: { prompt: '0.001', completion: '0.001' },
        })
      );
      models.push(
        createModel({
          id: 'cheap-but-large-context/model',
          context_length: 2_000_000,
          pricing: { prompt: '0.0000001', completion: '0.0000001' },
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toContain('cheap-but-large-context/model');
    });

    it('still excludes top context models if always-excluded (free)', () => {
      const models = Array.from({ length: 99 }, (_, index) =>
        createModel({
          id: `normal/model-${String(index)}`,
          context_length: 100_000,
        })
      );
      models.push(
        createModel({
          id: 'free-large-context/model',
          context_length: 2_000_000,
          pricing: { prompt: '0', completion: '0' },
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain('free-large-context/model');
    });

    it('still excludes top context models if always-excluded (name pattern)', () => {
      const models = Array.from({ length: 99 }, (_, index) =>
        createModel({
          id: `normal/model-${String(index)}`,
          context_length: 100_000,
        })
      );
      models.push(
        createModel({
          id: 'utility-large-context/model',
          context_length: 2_000_000,
          name: 'Body Builder Large',
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain('utility-large-context/model');
    });
  });

  describe('premium classification', () => {
    it('marks models in top 25% price as premium', () => {
      // Use realistic per-token prices ($0.001/1K to $0.01/1K per side)
      const models = Array.from({ length: 10 }, (_, index) =>
        createModel({
          id: `model-${String(index)}`,
          pricing: {
            prompt: String(0.000_001 * (index + 1)),
            completion: String(0.000_001 * (index + 1)),
          },
          created: Math.floor(twoYearsAgo / 1000), // Old, so recency doesn't make them premium
        })
      );

      const result = processModels(models);

      expect(result.premiumIds).toContain('model-9');
      expect(result.premiumIds).toContain('model-8');
      expect(result.premiumIds).not.toContain('model-0');
    });

    it('marks recent models as premium regardless of price', () => {
      const models = [
        createModel({
          id: 'old-expensive/model',
          pricing: { prompt: '0.1', completion: '0.1' },
          created: Math.floor(twoYearsAgo / 1000),
        }),
        createModel({
          id: 'new-cheap/model',
          pricing: { prompt: '0.0001', completion: '0.0001' },
          created: Math.floor(now / 1000),
        }),
      ];

      const result = processModels(models);

      expect(result.premiumIds).toContain('new-cheap/model');
    });

    it('calculates price percentile on filtered models only', () => {
      const models = Array.from({ length: 20 }, (_, index) =>
        createModel({
          id: `normal/model-${String(index)}`,
          context_length: 200_000,
          pricing: { prompt: '0.001', completion: '0.001' },
        })
      );
      models.push(
        createModel({
          id: 'old-expensive/model',
          context_length: 50_000,
          pricing: { prompt: '1.0', completion: '1.0' },
          created: Math.floor(threeYearsAgo / 1000),
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain('old-expensive/model');
      // 20 real models + 1 Smart Model entry
      expect(realModelIds(result)).toHaveLength(20);
    });
  });

  describe('transformation', () => {
    it('transforms raw gateway model to Model type with fees baked in', () => {
      const models = [
        createModel({
          id: 'openai/gpt-4-turbo',
          name: 'GPT-4 Turbo',
          description: 'Most capable GPT-4',
          context_length: 128_000,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: ['temperature', 'tools', 'tool_choice'],
          created: 1_704_067_200,
        }),
      ];

      const result = processModels(models);
      const model = result.models[0];

      expect(model).toMatchObject({
        id: 'openai/gpt-4-turbo',
        name: 'GPT-4 Turbo',
        description: 'Most capable GPT-4',
        provider: 'OpenAI',
        contextLength: 128_000,
        created: 1_704_067_200,
      });
      // Prices are fee-inclusive per the `processModels` contract.
      expect(model?.pricePerInputToken).toBeCloseTo(applyFees(0.000_01), 15);
      expect(model?.pricePerOutputToken).toBeCloseTo(applyFees(0.000_03), 15);
    });

    it('extracts provider from model ID prefix', () => {
      const testCases = [
        { id: 'openai/gpt-4', expected: 'OpenAI' },
        { id: 'anthropic/claude', expected: 'Anthropic' },
        { id: 'google/gemini', expected: 'Google' },
        { id: 'meta-llama/llama-3', expected: 'Meta' },
        { id: 'mistral/mistral-large', expected: 'Mistral' },
        { id: 'deepseek/deepseek-r1', expected: 'DeepSeek' },
        { id: 'unknown/model', expected: 'Unknown' },
      ];

      for (const { id, expected } of testCases) {
        const models = [createModel({ id })];
        const result = processModels(models);
        expect(result.models[0]?.provider).toBe(expected);
      }
    });

    it('extracts provider from name format "Provider: Model Name"', () => {
      const models = [
        createModel({
          id: 'someunknown/model',
          name: 'Acme Corp: Super Model',
        }),
      ];

      const result = processModels(models);

      expect(result.models[0]?.provider).toBe('Acme Corp');
      expect(result.models[0]?.name).toBe('Super Model');
    });

    it('splits on first colon when name has multiple colons', () => {
      const models = [
        createModel({
          id: 'someunknown/model',
          name: 'Provider: Model: Version 2',
        }),
      ];

      const result = processModels(models);

      expect(result.models[0]?.provider).toBe('Provider');
      expect(result.models[0]?.name).toBe('Model: Version 2');
    });

    it('falls back to ID prefix when name has only whitespace after colon', () => {
      const models = [
        createModel({
          id: 'openai/model',
          name: 'Provider:   ',
        }),
      ];

      const result = processModels(models);

      expect(result.models[0]?.provider).toBe('OpenAI');
    });

    it('assigns no capabilities to text models (Perplexity tool runs model-agnostically)', () => {
      const modelsData = [
        createModel({
          id: 'with-tools/model',
          supported_parameters: ['tools', 'web_search_options'],
        }),
        createModel({
          id: 'basic/model',
          supported_parameters: ['temperature'],
        }),
      ];

      const result = processModels(modelsData);

      for (const model of result.models) {
        expect(model.capabilities).toEqual([]);
      }
    });
  });

  describe('smart model injection', () => {
    it('injects a synthetic Smart Model entry when the pool has at least one real model', () => {
      const models = [createModel({ id: 'normal/model' })];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toContain(SMART_MODEL_ID);
    });

    it('sets isSmartModel flag on the injected entry', () => {
      const models = [createModel({ id: 'normal/model' })];

      const result = processModels(models);
      const smart = result.models.find((m) => m.id === SMART_MODEL_ID);

      expect(smart?.isSmartModel).toBe(true);
    });

    it('uses Smart Model display name and HushBox provider', () => {
      const models = [createModel({ id: 'normal/model' })];

      const result = processModels(models);
      const smart = result.models.find((m) => m.id === SMART_MODEL_ID);

      expect(smart?.name).toBe('Smart Model');
      expect(smart?.provider).toBe('HushBox');
    });

    it('headline price tracks the cheapest pool input/output (fee-inclusive, dynamic)', () => {
      const cheapModel = createModel({
        id: 'cheap/model',
        pricing: { prompt: '0.0001', completion: '0.0002' },
      });
      const expensiveModel = createModel({
        id: 'expensive/model',
        pricing: { prompt: '0.01', completion: '0.02' },
      });
      const result = processModels([cheapModel, expensiveModel]);
      const smart = result.models.find((m) => m.id === SMART_MODEL_ID);

      // Headline pricing is derived from the eligible-model price spread,
      // not the static `SMART_MODEL_*_PRICE_PER_TOKEN` constants.
      // Fee-inclusive per the `processModels` contract.
      expect(smart?.pricePerInputToken).toBeCloseTo(applyFees(0.0001), 15);
      expect(smart?.pricePerOutputToken).toBeCloseTo(applyFees(0.0002), 15);
    });

    it('omits the Smart Model entry entirely when the eligible pool is empty', () => {
      const result = processModels([]);
      expect(result.models.find((m) => m.id === SMART_MODEL_ID)).toBeUndefined();
    });

    it('computes fee-inclusive price ranges from the model pool', () => {
      const cheapModel = createModel({
        id: 'cheap/model',
        pricing: { prompt: '0.0001', completion: '0.0002' },
      });
      const expensiveModel = createModel({
        id: 'expensive/model',
        pricing: { prompt: '0.01', completion: '0.02' },
      });
      const models = [cheapModel, expensiveModel];

      const result = processModels(models);
      const smart = result.models.find((m) => m.id === SMART_MODEL_ID);

      expect(smart?.minPricePerInputToken).toBeCloseTo(applyFees(0.0001), 15);
      expect(smart?.minPricePerOutputToken).toBeCloseTo(applyFees(0.0002), 15);
      expect(smart?.maxPricePerInputToken).toBeCloseTo(applyFees(0.01), 15);
      expect(smart?.maxPricePerOutputToken).toBeCloseTo(applyFees(0.02), 15);
    });

    it('does not classify the Smart Model entry as premium', () => {
      const models = [createModel({ id: 'normal/model' })];

      const result = processModels(models);

      expect(result.premiumIds).not.toContain(SMART_MODEL_ID);
    });

    it('is omitted entirely when every real model is filtered out', () => {
      // Only a free model — filtered out by isExcludedAlways → pool empty.
      const models = [createModel({ id: 'free/model', pricing: { prompt: '0', completion: '0' } })];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain(SMART_MODEL_ID);
    });

    it('uses the max context length from the pool', () => {
      const models = [
        createModel({ id: 'a/model', context_length: 100_000 }),
        createModel({ id: 'b/model', context_length: 1_000_000 }),
      ];

      const result = processModels(models);
      const smart = result.models.find((m) => m.id === SMART_MODEL_ID);

      expect(smart?.contextLength).toBe(1_000_000);
    });
  });

  describe('trial affordability classification', () => {
    it('marks models that exceed trial budget as premium even when below price percentile', () => {
      // Need enough models so that Sonar Reasoning Pro pricing is NOT in the top 25% by combined price,
      // but IS too expensive for trial users due to high output cost.
      // Sonar Reasoning Pro: prompt=$0.0023/1K, completion=$0.0092/1K → combined=$0.0115/1K
      // Add models with higher combined prices so Sonar isn't in top 25% by price.
      const models = [
        // 8 models more expensive (combined price) than Sonar — keeps Sonar below 75th percentile
        ...Array.from({ length: 8 }, (_, index) =>
          createModel({
            id: `expensive/model-${String(index)}`,
            pricing: { prompt: '0.00005', completion: '0.00005' }, // $0.1/1K combined — very expensive
            created: Math.floor(twoYearsAgo / 1000),
          })
        ),
        // 4 models cheaper than Sonar
        ...Array.from({ length: 4 }, (_, index) =>
          createModel({
            id: `cheap/model-${String(index)}`,
            pricing: { prompt: '0.000001', completion: '0.000001' }, // $0.002/1K combined — cheap
            created: Math.floor(twoYearsAgo / 1000),
          })
        ),
        // Sonar Reasoning Pro: below 75th percentile by combined price, but output too expensive for trial
        createModel({
          id: 'perplexity/sonar-reasoning-pro',
          pricing: { prompt: '0.0000023', completion: '0.0000092' },
          created: Math.floor(twoYearsAgo / 1000),
        }),
      ];

      const result = processModels(models);

      // Sonar should be marked premium due to trial affordability, not price percentile
      expect(result.premiumIds).toContain('perplexity/sonar-reasoning-pro');
      // Cheap models should NOT be premium
      expect(result.premiumIds).not.toContain('cheap/model-0');
    });
  });

  describe('edge cases', () => {
    it('handles empty array', () => {
      const result = processModels([]);

      expect(result.models).toEqual([]);
      expect(result.premiumIds).toEqual([]);
    });

    it('handles single model', () => {
      const models = [createModel({ id: 'only/model' })];

      const result = processModels(models);

      // 1 real model + 1 Smart Model entry
      expect(realModelIds(result)).toEqual(['only/model']);
    });
  });

  describe('image modality', () => {
    it('includes image models with flat per_image pricing', () => {
      const models = [
        createModel({ id: 'text/model' }),
        createImageModel({ id: 'google/imagen-4.0-generate-001' }),
      ];

      const result = processModels(models);

      const imagen = result.models.find((m) => m.id === 'google/imagen-4.0-generate-001');
      expect(imagen).toBeDefined();
      expect(imagen?.modality).toBe('image');
      // Fee-inclusive per the `processModels` contract.
      expect(imagen?.pricePerImage).toBeCloseTo(applyFees(0.04), 15);
      expect(imagen?.pricePerInputToken).toBe(0);
      expect(imagen?.pricePerOutputToken).toBe(0);
    });

    it('excludes image models without per_image pricing', () => {
      const models = [
        createImageModel({
          id: 'gemini/variable',
          pricing: { prompt: '0', completion: '0' },
        }),
      ];

      const result = processModels(models);

      expect(result.models.find((m) => m.id === 'gemini/variable')).toBeUndefined();
    });

    it('excludes image models with per_image price of zero', () => {
      const models = [
        createImageModel({
          id: 'free/image',
          pricing: { prompt: '0', completion: '0', per_image: '0' },
        }),
      ];
      expect(processModels(models).models.find((m) => m.id === 'free/image')).toBeUndefined();
    });

    it('marks every image model as premium', () => {
      const models = [createImageModel({ id: 'google/imagen-4.0-generate-001' })];

      const result = processModels(models);

      expect(result.premiumIds).toContain('google/imagen-4.0-generate-001');
    });

    it('does not inject Smart Model for image modality', () => {
      const models = [createImageModel({ id: 'google/imagen-4.0-generate-001' })];

      const result = processModels(models);

      // Smart Model only appears when the text pool is non-empty
      expect(result.models.find((m) => m.id === SMART_MODEL_ID)).toBeUndefined();
    });
  });

  describe('video modality', () => {
    it('includes video models with per-resolution pricing', () => {
      const models = [createVideoModel({ id: 'google/veo-3.1-generate-001' })];

      const result = processModels(models);

      const veo = result.models.find((m) => m.id === 'google/veo-3.1-generate-001');
      expect(veo).toBeDefined();
      expect(veo?.modality).toBe('video');
      // Fee-inclusive per the `processModels` contract.
      expect(veo?.pricePerSecondByResolution['720p']).toBeCloseTo(applyFees(0.4), 15);
      expect(veo?.pricePerSecondByResolution['1080p']).toBeCloseTo(applyFees(0.4), 15);
      expect(veo?.pricePerInputToken).toBe(0);
      expect(veo?.pricePerOutputToken).toBe(0);
      expect(veo?.pricePerImage).toBe(0);
    });

    it('excludes video models without per_second_by_resolution', () => {
      const models = [
        createVideoModel({
          id: 'bytedance/seedance',
          pricing: { prompt: '0', completion: '0' },
        }),
      ];

      const result = processModels(models);

      expect(result.models.find((m) => m.id === 'bytedance/seedance')).toBeUndefined();
    });

    it('excludes video models with empty per_second_by_resolution', () => {
      const models = [
        createVideoModel({
          id: 'empty/video',
          pricing: { prompt: '0', completion: '0', per_second_by_resolution: {} },
        }),
      ];
      expect(processModels(models).models.find((m) => m.id === 'empty/video')).toBeUndefined();
    });

    it('marks every video model as premium', () => {
      const models = [createVideoModel({ id: 'google/veo-3.1-generate-001' })];

      const result = processModels(models);

      expect(result.premiumIds).toContain('google/veo-3.1-generate-001');
    });

    it('parses per-resolution prices as numbers', () => {
      const models = [
        createVideoModel({
          id: 'vendor/v',
          pricing: {
            prompt: '0',
            completion: '0',
            per_second_by_resolution: { '720p': '0.15', '1080p': '0.30' },
          },
        }),
      ];

      const result = processModels(models);
      const v = result.models.find((m) => m.id === 'vendor/v');
      // Fee-inclusive per the `processModels` contract.
      expect(v?.pricePerSecondByResolution['720p']).toBeCloseTo(applyFees(0.15), 15);
      expect(v?.pricePerSecondByResolution['1080p']).toBeCloseTo(applyFees(0.3), 15);
    });
  });

  describe('audio modality', () => {
    it('includes audio models with positive per_second pricing', () => {
      const models = [createAudioModel({ id: 'openai/tts-1' })];

      const result = processModels(models);

      const tts = result.models.find((m) => m.id === 'openai/tts-1');
      expect(tts).toBeDefined();
      expect(tts?.modality).toBe('audio');
      // Fee-inclusive per the `processModels` contract.
      expect(tts?.pricePerSecond).toBeCloseTo(applyFees(0.015), 15);
      expect(tts?.pricePerInputToken).toBe(0);
      expect(tts?.pricePerOutputToken).toBe(0);
      expect(tts?.pricePerImage).toBe(0);
    });

    it('excludes audio models without per_second pricing', () => {
      const models = [
        createAudioModel({
          id: 'no-price/audio',
          pricing: { prompt: '0', completion: '0' },
        }),
      ];
      expect(processModels(models).models.find((m) => m.id === 'no-price/audio')).toBeUndefined();
    });

    it('excludes audio models with zero per_second pricing', () => {
      const models = [
        createAudioModel({
          id: 'zero/audio',
          pricing: { prompt: '0', completion: '0', per_second: '0' },
        }),
      ];
      expect(processModels(models).models.find((m) => m.id === 'zero/audio')).toBeUndefined();
    });

    it('marks every audio model as premium', () => {
      const models = [createAudioModel({ id: 'openai/tts-1' })];

      const result = processModels(models);

      expect(result.premiumIds).toContain('openai/tts-1');
    });

    it('parses per_second pricing as a number', () => {
      const models = [
        createAudioModel({
          id: 'vendor/a',
          pricing: { prompt: '0', completion: '0', per_second: '0.030' },
        }),
      ];

      const result = processModels(models);
      const a = result.models.find((m) => m.id === 'vendor/a');
      // Fee-inclusive per the `processModels` contract.
      expect(a?.pricePerSecond).toBeCloseTo(applyFees(0.03), 15);
    });
  });

  describe('multi-modality combinations', () => {
    it('returns text, image, video, and audio models in a single array', () => {
      const models = [
        createModel({ id: 'text/one' }),
        createImageModel({ id: 'image/one' }),
        createVideoModel({ id: 'video/one' }),
        createAudioModel({ id: 'audio/one' }),
      ];

      const result = processModels(models);
      const ids = result.models.map((m) => m.id);

      expect(ids).toContain('text/one');
      expect(ids).toContain('image/one');
      expect(ids).toContain('video/one');
      expect(ids).toContain('audio/one');
      expect(ids).toContain(SMART_MODEL_ID);
    });

    it('text and media models each classify under their own modality', () => {
      const models = [
        createModel({ id: 'text/one' }),
        createImageModel({ id: 'image/one' }),
        createVideoModel({ id: 'video/one' }),
        createAudioModel({ id: 'audio/one' }),
      ];

      const result = processModels(models);
      const text = result.models.find((m) => m.id === 'text/one');
      const image = result.models.find((m) => m.id === 'image/one');
      const video = result.models.find((m) => m.id === 'video/one');
      const audio = result.models.find((m) => m.id === 'audio/one');

      expect(text?.modality).toBe('text');
      expect(image?.modality).toBe('image');
      expect(video?.modality).toBe('video');
      expect(audio?.modality).toBe('audio');
    });
  });

  describe('per-model capability annotations', () => {
    it('annotates Imagen 4 with the 5 standard aspect ratios', () => {
      const models = [createImageModel({ id: 'google/imagen-4.0-generate-001' })];
      const result = processModels(models);
      const imagen = result.models.find((m) => m.id === 'google/imagen-4.0-generate-001');
      expect(imagen?.supportedAspectRatios).toEqual(['1:1', '4:3', '3:4', '16:9', '9:16']);
    });

    it('annotates Veo 3.1 with 4-6-8s durations and 720p/1080p/4k resolutions', () => {
      const models = [
        createVideoModel({
          id: 'google/veo-3.1-generate-001',
          pricing: {
            prompt: '0',
            completion: '0',
            per_second_by_resolution: { '720p': '0.4', '1080p': '0.4', '4k': '0.6' },
          },
        }),
      ];
      const result = processModels(models);
      const veo = result.models.find((m) => m.id === 'google/veo-3.1-generate-001');
      expect(veo?.supportedAspectRatios).toEqual(['16:9', '9:16']);
      expect(veo?.supportedVideoResolutions).toEqual(['720p', '1080p', '4k']);
      expect(veo?.supportedVideoDurationsSeconds).toEqual([4, 6, 8]);
    });

    it('annotates Veo 3.0 with 4-6-8s durations and 720p/1080p only (no 4k)', () => {
      const models = [createVideoModel({ id: 'google/veo-3.0-generate-001' })];
      const result = processModels(models);
      const veo30 = result.models.find((m) => m.id === 'google/veo-3.0-generate-001');
      expect(veo30?.supportedVideoResolutions).toEqual(['720p', '1080p']);
      expect(veo30?.supportedVideoDurationsSeconds).toEqual([4, 6, 8]);
    });

    it('leaves capability fields undefined for non-Veo, non-Imagen models', () => {
      const models = [createModel({ id: 'openai/gpt-5' })];
      const result = processModels(models);
      const gpt = result.models.find((m) => m.id === 'openai/gpt-5');
      expect(gpt?.supportedAspectRatios).toBeUndefined();
      expect(gpt?.supportedVideoResolutions).toBeUndefined();
      expect(gpt?.supportedVideoDurationsSeconds).toBeUndefined();
    });
  });
});

describe('pickValueTextModel', () => {
  // `isPremiumModel` flags anything <6 months old as premium (regardless of
  // price), and `isExcludedByStandardCriteria` excludes anything >2 years old.
  // Fixtures use a value safely inside the [6mo, 2y] window so they appear in
  // `filtered` AND are not flagged premium-by-recency.
  const oldCreated = Math.floor((now - 365 * 24 * 60 * 60 * 1000) / 1000);

  it('returns the id of the cheapest non-premium text model in the catalog', () => {
    // Output prices stay below the trial-budget ceiling (~0.000005/token) so
    // `exceedsTrialBudget` doesn't downgrade these to premium.
    const raws = [
      createModel({
        id: 'openai/gpt-5',
        modality: 'text',
        pricing: { prompt: '0.000004', completion: '0.000004' },
        created: oldCreated,
      }),
      createModel({
        id: 'anthropic/claude-haiku-4.5',
        modality: 'text',
        pricing: { prompt: '0.000001', completion: '0.000001' },
        created: oldCreated,
      }),
      createModel({
        id: 'openai/gpt-4o-mini',
        modality: 'text',
        pricing: { prompt: '0.000002', completion: '0.000002' },
        created: oldCreated,
      }),
    ];

    expect(pickValueTextModel(raws)).toBe('anthropic/claude-haiku-4.5');
  });

  it('skips premium text models even when they are the cheapest', () => {
    // The cheaper entry is recent → flagged premium by recency, despite low
    // price. Selector must skip it and return the older non-premium entry.
    // Prices follow the working pattern from the 'premium classification'
    // describe above so output cost stays under the trial budget.
    const raws = [
      createModel({
        id: 'recent/expensive',
        modality: 'text',
        pricing: { prompt: '0.000010', completion: '0.000010' },
        created: Math.floor(now / 1000),
      }),
      createModel({
        id: 'recent/cheaper-but-recent',
        modality: 'text',
        pricing: { prompt: '0.000002', completion: '0.000002' },
        created: Math.floor(now / 1000),
      }),
      createModel({
        id: 'old/stable-value',
        modality: 'text',
        pricing: { prompt: '0.000001', completion: '0.000001' },
        created: oldCreated,
      }),
    ];

    expect(pickValueTextModel(raws)).toBe('old/stable-value');
  });

  it('skips image, video, and audio models', () => {
    // Two text models so the cheaper one escapes the 75th-percentile premium
    // check; an image model in the same catalog must be ignored entirely.
    const raws = [
      createImageModel({ id: 'google/imagen-4.0-generate-001' }),
      createModel({
        id: 'anthropic/claude-haiku-4.5',
        modality: 'text',
        pricing: { prompt: '0.000001', completion: '0.000001' },
        created: oldCreated,
      }),
      createModel({
        id: 'openai/gpt-5',
        modality: 'text',
        pricing: { prompt: '0.000004', completion: '0.000004' },
        created: oldCreated,
      }),
    ];

    expect(pickValueTextModel(raws)).toBe('anthropic/claude-haiku-4.5');
  });

  it('throws when no non-premium text model exists (catalog drift guard)', () => {
    const raws = [
      createModel({
        id: 'recent/only',
        modality: 'text',
        pricing: { prompt: '0.00010', completion: '0.00020' },
        created: Math.floor(now / 1000),
      }),
    ];

    expect(() => pickValueTextModel(raws)).toThrow(/no non-premium text model/i);
  });

  it('throws when no text models exist at all', () => {
    expect(() => pickValueTextModel([])).toThrow(/no non-premium text model/i);
  });
});

describe('pickValueTextModels', () => {
  // Same window rationale as pickValueTextModel: created inside [6mo, 2y] so the
  // fixtures land in `filtered` and aren't flagged premium-by-recency.
  const oldCreated = Math.floor((now - 365 * 24 * 60 * 60 * 1000) / 1000);

  function valueModel(id: string, perToken: string) {
    return createModel({
      id,
      modality: 'text',
      pricing: { prompt: perToken, completion: perToken },
      created: oldCreated,
    });
  }

  it('returns the N distinct cheapest non-premium text ids in ascending price order', () => {
    // 4 text models; per-token prices stay ≤ 0.000002 so the bottom three clear
    // the trial-affordability budget, and the 75th-percentile premium cut flags
    // only the priciest (D), leaving A < B < C as the non-premium pool.
    const raws = [
      valueModel('p/c', '0.0000015'),
      valueModel('p/a', '0.000001'),
      valueModel('p/d', '0.000002'),
      valueModel('p/b', '0.0000012'),
    ];

    expect(pickValueTextModels(raws, 2)).toEqual(['p/a', 'p/b']);
    expect(pickValueTextModels(raws, 3)).toEqual(['p/a', 'p/b', 'p/c']);
  });

  it('excludes premium and non-text models from the result', () => {
    const raws = [
      createImageModel({ id: 'google/imagen-4.0-generate-001' }),
      valueModel('p/a', '0.000001'),
      valueModel('p/b', '0.0000015'),
      // Priciest text entry AND recent → flagged premium by both percentile and
      // recency, so it never lands in the value picks.
      createModel({
        id: 'p/recent',
        modality: 'text',
        pricing: { prompt: '0.000002', completion: '0.000002' },
        created: Math.floor(now / 1000),
      }),
    ];

    expect(pickValueTextModels(raws, 2)).toEqual(['p/a', 'p/b']);
  });

  it('throws when fewer than N non-premium text models exist (catalog drift guard)', () => {
    const raws = [valueModel('p/a', '0.000001'), valueModel('p/b', '0.000002')];

    // 2 models → the 75th-percentile cut flags the pricier one premium, leaving
    // only 1 eligible, so a request for 2 cannot be satisfied.
    expect(() => pickValueTextModels(raws, 2)).toThrow(/non-premium text model/i);
  });

  it('throws when no text models exist at all', () => {
    expect(() => pickValueTextModels([], 1)).toThrow(/non-premium text model/i);
  });
});
// Uncoverable branch notes, all noUncheckedIndexedAccess narrowing on
// module-private helpers:
// - calculatePercentileThreshold's `?? 0`: the empty-input early return plus
//   Math.min(index, length - 1) keep the lookup in-range on a dense array.
// - extractProvider's `split('/')[0] ?? ''`: String.split always returns at
//   least one element.
// - transformImage's `perImageRaw === undefined ? 0 : ...` consequent and
//   transformAudio's per-second twin: both transforms run only on models
//   that passed hasFlatImagePricing / hasFlatAudioPricing, which require the
//   field to be defined and positive.
// - transformVideo's `?? {}`: gated the same way by hasPerResolutionPricing.
