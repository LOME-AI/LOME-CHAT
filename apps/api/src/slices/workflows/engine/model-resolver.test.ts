import { describe, expect, it } from 'vitest';
import { nanoUSD, textTag } from '@hushbox/shared';
import { priceUsageBaseNanoUsd } from '../../models/index.js';
import { createModelResolver } from './model-resolver.js';
import type { Modality, ModelDescriptor, Pricing, Usage } from '@hushbox/shared';
import type { ModelPricingResolver } from '../../models/index.js';

function descriptorWith(
  id: string,
  inputs: readonly Modality[],
  outputs: readonly Modality[],
  pricing: Pricing = {}
): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: [...inputs],
    outputs: [...outputs],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing,
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

function resolverOver(descriptors: readonly ModelDescriptor[]): ModelPricingResolver {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  return (modelId) => byId.get(modelId);
}

describe('createModelResolver', () => {
  it('binds a known representable model to its descriptor, derived ports, and pricer', () => {
    const descriptor = descriptorWith('answer-model', ['text'], ['text']);
    const resolver = createModelResolver(resolverOver([descriptor]));
    const binding = resolver.resolve('answer-model');
    expect(binding?.descriptor).toBe(descriptor);
    expect(binding?.ports).toEqual({ in: [textTag()], out: textTag() });
  });

  it('prices through the catalog base pricer, pre-markup', () => {
    const pricing: Pricing = { inputPerToken: nanoUSD(2n), outputPerToken: nanoUSD(3n) };
    const descriptor = descriptorWith('priced-model', ['text'], ['text'], pricing);
    const resolver = createModelResolver(resolverOver([descriptor]));
    const usage: Usage = { inputTokens: 10, outputTokens: 20 };
    const priced = resolver.resolve('priced-model')?.price(usage);
    expect(priced?._unsafeUnwrap()).toBe(priceUsageBaseNanoUsd(pricing, usage)._unsafeUnwrap());
    expect(priced?._unsafeUnwrap()).toBe(80n);
  });

  it('fails closed on an unknown model id', () => {
    const resolver = createModelResolver(resolverOver([]));
    expect(resolver.resolve('missing')).toBeUndefined();
  });

  it('fails closed on a model whose modalities are unrepresentable as ports', () => {
    const descriptor = descriptorWith('embed-model', ['text'], ['embedding']);
    const resolver = createModelResolver(resolverOver([descriptor]));
    expect(resolver.resolve('embed-model')).toBeUndefined();
  });
});
