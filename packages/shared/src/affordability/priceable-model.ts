/**
 * `PriceableModel` — the narrow projection the money layer consumes instead of
 * the catalog descriptor (`docs/BILLING.md` §Data Structures). It is
 * load-bearing: because pricing, feasibility and the dimension registry read
 * this shape rather than a catalog row, a new catalog field or a new modality
 * cannot reshape money inputs, and every money function is testable against
 * hand-built fixtures with no catalog knowledge.
 *
 * A release timestamp, a display name, a popularity rank and a ZDR flag are
 * deliberately NOT here: none of them is a money input. A function that needs
 * one takes it as its own argument (see `premium.ts`), which is what keeps this
 * shape from drifting back into a descriptor copy.
 */

import { ratesFromPricing } from './estimate/run-ceiling.js';
import { validCap } from './estimate/reasoning-plan.js';
import { nanoUSD } from './nano-usd.js';
import type { ModelReasoning, ModelDescriptor } from './model-descriptor.js';
import type { NanoUSD } from './nano-usd.js';
import type { ReasoningPlanModel } from './estimate/reasoning-plan.js';

export interface PriceableModel {
  readonly modelId: string;
  /** Billable (fee-inclusive) nano-USD per input token. */
  readonly inputRateNanoUsd: NanoUSD;
  /** Billable (fee-inclusive) nano-USD per output token. */
  readonly outputRateNanoUsd: NanoUSD;
  readonly contextLength: number;
  /** Catalog max output tokens; absent ⇒ the context length alone bounds. */
  readonly providerCap: number | undefined;
  readonly reasoning: ModelReasoning | undefined;
}

/**
 * The projection, or `undefined` when the descriptor is not priceable — a
 * missing per-token rate or context length fails closed rather than becoming a
 * zero rate, because a zero rate prices a turn as free. Being priceable is
 * exactly membership in §Predicates' priceable catalog pool.
 */
export function priceableModelFrom(descriptor: ModelDescriptor): PriceableModel | undefined {
  const rates = ratesFromPricing(descriptor.pricing);
  if (rates.inputPerToken === undefined || rates.outputPerToken === undefined) return undefined;
  const contextLength = validCap(descriptor.limits['contextLength']);
  if (contextLength === undefined) return undefined;
  return {
    modelId: descriptor.id,
    inputRateNanoUsd: nanoUSD(rates.inputPerToken),
    outputRateNanoUsd: nanoUSD(rates.outputPerToken),
    contextLength,
    providerCap: validCap(descriptor.limits['maxOutputTokens']),
    reasoning: descriptor.reasoning,
  };
}

/**
 * The reasoning-plan input for a projected model. The plan's own field is named
 * `maxOutputTokens` (the catalog word) while the projection calls the same
 * quantity `providerCap` (the specification word); this is the one place the two
 * names meet, so no caller has to know they are the same number.
 */
export function reasoningPlanModelOf(model: PriceableModel): ReasoningPlanModel {
  return {
    reasoning: model.reasoning,
    contextLength: model.contextLength,
    maxOutputTokens: model.providerCap,
  };
}
