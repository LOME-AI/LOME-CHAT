import { describe, expect, it } from 'vitest';

import { nanoUSD } from './nano-usd.js';
import { priceableModelFrom, reasoningPlanModelOf } from './priceable-model.js';
import type { ModelDescriptor } from './model-descriptor.js';
import type { PriceableModel } from './priceable-model.js';

function descriptorFor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'vendor/model',
    provider: 'vendor',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: 200_000, maxOutputTokens: 64_000 },
    pricing: { inputPerToken: nanoUSD(300n), outputPerToken: nanoUSD(1500n) },
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 1_700_000_100,
    ...overrides,
  };
}

describe('priceableModelFrom', () => {
  it('projects the six money inputs off a catalog descriptor', () => {
    expect(priceableModelFrom(descriptorFor())).toEqual({
      modelId: 'vendor/model',
      inputRateNanoUsd: 300n,
      outputRateNanoUsd: 1500n,
      contextLength: 200_000,
      providerCap: 64_000,
      reasoning: undefined,
    });
  });

  it('carries the reasoning metadata through verbatim', () => {
    const reasoning = { supportedEfforts: ['high', 'low'], mandatory: true };
    expect(priceableModelFrom(descriptorFor({ reasoning }))?.reasoning).toEqual(reasoning);
  });

  it('leaves providerCap absent when the catalog declares no usable completion cap', () => {
    const projected = priceableModelFrom(
      descriptorFor({ limits: { contextLength: 8192, maxOutputTokens: 0 } })
    );
    expect(projected?.providerCap).toBeUndefined();
  });

  it('refuses a descriptor with no input rate — an unpriceable model, never a zero', () => {
    expect(
      priceableModelFrom(descriptorFor({ pricing: { outputPerToken: nanoUSD(1500n) } }))
    ).toBeUndefined();
  });

  it('refuses a descriptor with no output rate', () => {
    expect(
      priceableModelFrom(descriptorFor({ pricing: { inputPerToken: nanoUSD(300n) } }))
    ).toBeUndefined();
  });

  it('refuses a descriptor with no declared context length', () => {
    expect(priceableModelFrom(descriptorFor({ limits: {} }))).toBeUndefined();
  });

  it('does not widen when the catalog grows a field', () => {
    const projected = priceableModelFrom(descriptorFor({ popularityRank: 3, name: 'Model' }));
    expect(Object.keys(projected ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'contextLength',
      'inputRateNanoUsd',
      'modelId',
      'outputRateNanoUsd',
      'providerCap',
      'reasoning',
    ]);
  });
});

describe('reasoningPlanModelOf', () => {
  it('maps the projection onto the reasoning plan input', () => {
    const model: PriceableModel = {
      modelId: 'vendor/model',
      inputRateNanoUsd: nanoUSD(300n),
      outputRateNanoUsd: nanoUSD(1500n),
      contextLength: 200_000,
      providerCap: 64_000,
      reasoning: { supportedEfforts: null },
    };
    expect(reasoningPlanModelOf(model)).toEqual({
      reasoning: { supportedEfforts: null },
      contextLength: 200_000,
      maxOutputTokens: 64_000,
    });
  });
});
