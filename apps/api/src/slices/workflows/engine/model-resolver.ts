import { callShapeFamilyFor } from '@hushbox/shared';
import { priceMediaBaseNanoUsd, priceUsageBaseNanoUsd } from '../../models/index.js';
import { deriveModelPorts } from './model-ports.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ModelBinding, ModelResolver } from './live-execution-registry.js';

/**
 * The production model resolver the flow engine reads on the turn hot path.
 * It composes a catalog snapshot (the sync `ModelPricingResolver` — exposed
 * models only, fail-closed) with the shared port derivation and the base
 * (pre-markup) pricer: a resolved binding carries the descriptor, its derived
 * node ports, and a `price` over observed usage. A model that is unknown,
 * unexposed, or whose modalities have no port representation resolves to
 * `undefined` — the same fail-closed result the compile-time node registry
 * reads, so a model that compiles is exactly a model that can run.
 */
export function createModelResolver(descriptors: ModelPricingResolver): ModelResolver {
  return { resolve: (modelId) => resolveModel(descriptors, modelId) };
}

function resolveModel(
  descriptors: ModelPricingResolver,
  modelId: string
): ModelBinding | undefined {
  const descriptor = descriptors(modelId);
  if (descriptor === undefined) return undefined;
  const ports = deriveModelPorts(descriptor);
  if (ports.isErr()) return undefined;
  return {
    descriptor,
    ports: ports.value,
    price: (usage) => priceUsageBaseNanoUsd(descriptor.pricing, usage),
    // Deterministic media price from catalog rates + call params — the same
    // derivation admission's ceiling uses, so a call that was admitted is a
    // call settlement can price.
    priceMedia: (params) =>
      priceMediaBaseNanoUsd(descriptor.pricing, callShapeFamilyFor(descriptor.outputs), params),
  };
}
