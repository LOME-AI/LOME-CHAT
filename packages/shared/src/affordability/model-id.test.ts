import { describe, expect, it } from 'vitest';
import { ModelId, modelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import type { PriceableModel } from './priceable-model.js';

describe('modelId', () => {
  it('brands a catalog identifier', () => {
    expect(modelId('vendor/model')).toBe('vendor/model');
  });

  it('rejects an empty identifier', () => {
    expect(() => modelId('')).toThrow();
  });
});

describe('ModelId', () => {
  it('parses a catalog identifier at a wire boundary', () => {
    expect(ModelId.parse('vendor/model')).toBe('vendor/model');
  });
});

describe('ModelId brand (compile-time)', () => {
  // The brand is the reason §Where the Code Lives' no-bare-`string` rule holds for
  // identifiers. Every fixture in this package routes through `modelId()`, so
  // rewriting `ModelId` to `type ModelId = string` would redden nothing without
  // this: the directive below would be flagged unused and `tsgo --noEmit` fails.
  it('rejects a plain string where a model identifier is expected', () => {
    const model: PriceableModel = {
      // @ts-expect-error — an unbranded string is not assignable to ModelId
      modelId: 'vendor/model',
      inputRateNanoUsd: nanoUSD(100n),
      outputRateNanoUsd: nanoUSD(200n),
      contextLength: 1000,
      providerCap: undefined,
      reasoning: undefined,
      releasedAtMs: 0,
    };
    expect(model.modelId).toBe('vendor/model');
  });
});
