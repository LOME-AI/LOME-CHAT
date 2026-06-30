import { describe, it, expect } from 'vitest';
import { requireCatalogConfig, requireInferenceConfig } from './gateway-config.js';
import type { Bindings } from '../types.js';

describe('requireCatalogConfig', () => {
  it('returns publicModelsUrl when present', () => {
    const env = {
      PUBLIC_MODELS_URL: 'https://example.com/models',
    } as unknown as Bindings;

    const result = requireCatalogConfig(env);

    expect(result.publicModelsUrl).toBe('https://example.com/models');
  });

  it('throws when PUBLIC_MODELS_URL is missing', () => {
    const env = {} as unknown as Bindings;

    expect(() => requireCatalogConfig(env)).toThrow(/PUBLIC_MODELS_URL required/);
  });
});

describe('requireInferenceConfig', () => {
  it('returns apiKey when present', () => {
    const env = {
      AI_GATEWAY_API_KEY: 'test-api-key',
    } as unknown as Bindings;

    const result = requireInferenceConfig(env);

    expect(result.apiKey).toBe('test-api-key');
  });

  it('throws when AI_GATEWAY_API_KEY is missing', () => {
    const env = {} as unknown as Bindings;

    expect(() => requireInferenceConfig(env)).toThrow(/AI_GATEWAY_API_KEY required/);
  });
});
