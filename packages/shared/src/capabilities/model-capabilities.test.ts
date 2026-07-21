import { describe, it, expect } from 'vitest';
import { getModelFeatures, modelHasFeature } from './model-capabilities.js';
import type { Model } from '../schemas/api/models.js';

describe('getModelFeatures', () => {
  it('returns only features with no requirements for model with no supported parameters', () => {
    const model: Model = {
      id: 'test/model',
      name: 'Test Model',
      provider: 'Test',
      modality: 'text' as const,
      contextLength: 4096,
      pricing: { inputPerToken: '1000', outputPerToken: '2000' },
      capabilities: [],
      description: 'A test model',
      supportedParameters: [],
    };

    const features = getModelFeatures(model);

    // Only vision is returned since it has no required parameters
    expect(features).toEqual(['vision']);
  });

  it('returns tool-based features for model with tools support', () => {
    const model: Model = {
      id: 'test/model',
      name: 'Test Model',
      provider: 'Test',
      modality: 'text' as const,
      contextLength: 4096,
      pricing: { inputPerToken: '1000', outputPerToken: '2000' },
      capabilities: [],
      description: 'A test model',
      supportedParameters: ['tools', 'temperature'],
    };

    const features = getModelFeatures(model);

    expect(features).toContain('python-execution');
    expect(features).toContain('javascript-execution');
    expect(features).toContain('vision'); // vision always included
  });

  it('handles undefined supportedParameters gracefully', () => {
    // Simulate a model where supportedParameters might be undefined (e.g., from API)
    const model = {
      id: 'test/model',
      name: 'Test Model',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'A test model',
      supportedParameters: undefined,
    } as unknown as Model;

    const features = getModelFeatures(model);

    // Should still return vision since it has no required parameters
    expect(features).toContain('vision');
  });
});

describe('modelHasFeature', () => {
  const modelWithTools: Model = {
    id: 'test/model-with-tools',
    name: 'Test Model With Tools',
    provider: 'Test',
    modality: 'text' as const,
    contextLength: 4096,
    pricing: { inputPerToken: '1000', outputPerToken: '2000' },
    capabilities: [],
    description: 'A test model with tools support',
    supportedParameters: ['tools', 'temperature', 'max_tokens'],
  };

  const modelWithoutTools: Model = {
    id: 'test/model-without-tools',
    name: 'Test Model Without Tools',
    provider: 'Test',
    modality: 'text' as const,
    contextLength: 4096,
    pricing: { inputPerToken: '1000', outputPerToken: '2000' },
    capabilities: [],
    description: 'A test model without tools support',
    supportedParameters: ['temperature', 'max_tokens'],
  };

  it('returns true when model has all required parameters', () => {
    expect(modelHasFeature(modelWithTools, 'python-execution')).toBe(true);
    expect(modelHasFeature(modelWithTools, 'javascript-execution')).toBe(true);
  });

  it('returns false when model lacks required parameters', () => {
    expect(modelHasFeature(modelWithoutTools, 'python-execution')).toBe(false);
    expect(modelHasFeature(modelWithoutTools, 'javascript-execution')).toBe(false);
  });

  it('returns true for features with no required parameters', () => {
    expect(modelHasFeature(modelWithTools, 'vision')).toBe(true);
    expect(modelHasFeature(modelWithoutTools, 'vision')).toBe(true);
  });
});
