import { describe, it, expect } from 'vitest';
import {
  modelSchema,
  type Model,
  MOCK_MODELS,
  modelCapabilitySchema,
  type ModelCapability,
} from './models.js';

describe('modelCapabilitySchema', () => {
  it('accepts valid capabilities', () => {
    const validCapabilities: ModelCapability[] = ['vision', 'functions', 'json-mode', 'streaming'];

    for (const cap of validCapabilities) {
      const result = modelCapabilitySchema.safeParse(cap);
      expect(result.success).toBe(true);
    }
  });

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
      contextLength: 128000,
      pricePerInputToken: 0.00001,
      pricePerOutputToken: 0.00003,
      capabilities: ['vision', 'functions', 'json-mode', 'streaming'],
      description: 'A powerful language model from OpenAI.',
    };

    const result = modelSchema.safeParse(validModel);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validModel);
    }
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
});

describe('MOCK_MODELS', () => {
  it('contains at least 3 models for testing', () => {
    expect(MOCK_MODELS.length).toBeGreaterThanOrEqual(3);
  });

  it('all mock models are valid', () => {
    for (const model of MOCK_MODELS) {
      const result = modelSchema.safeParse(model);
      expect(result.success).toBe(true);
    }
  });

  it('includes models from different providers', () => {
    const providers = new Set(MOCK_MODELS.map((m) => m.provider));
    expect(providers.size).toBeGreaterThanOrEqual(2);
  });

  it('includes models with vision capability', () => {
    const hasVision = MOCK_MODELS.some((m) => m.capabilities.includes('vision'));
    expect(hasVision).toBe(true);
  });

  it('all models have non-empty descriptions', () => {
    for (const model of MOCK_MODELS) {
      expect(model.description).toBeDefined();
      expect(model.description.length).toBeGreaterThan(0);
    }
  });
});

describe('Model type', () => {
  it('infers correct type from schema', () => {
    const model: Model = {
      id: 'test-model',
      name: 'Test Model',
      provider: 'Test Provider',
      contextLength: 8192,
      pricePerInputToken: 0.0001,
      pricePerOutputToken: 0.0002,
      capabilities: ['streaming'],
      description: 'A test model for type inference.',
    };

    expect(model.id).toBe('test-model');
    expect(model.capabilities).toContain('streaming');
    expect(model.description).toBe('A test model for type inference.');
  });
});
