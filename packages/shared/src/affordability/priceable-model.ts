/**
 * `PriceableModel` — the narrow projection the money layer consumes instead of
 * the catalog descriptor (`docs/BILLING.md` §Data Structures). It is
 * load-bearing: because pricing, feasibility and the dimension registry read
 * this shape rather than a catalog row, a new catalog field or a new modality
 * cannot reshape money inputs, and every money function is testable against
 * hand-built fixtures with no catalog knowledge.
 *
 * A display name, a popularity rank and a ZDR flag are deliberately NOT here:
 * none of them is a money input, which is what keeps this shape from drifting
 * back into a descriptor copy. The release timestamp IS here, because premium
 * classification is a money verdict this module owns (§Model Classification) and
 * it grades on recency — so a row cannot be classified without it. The clock it
 * is compared against stays an argument (see `premium.ts`), so no release date
 * gives this module a clock.
 */

import { ratesFromPricing } from './estimate/run-ceiling.js';
import { validCap } from './estimate/reasoning-plan.js';
import { modelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import type { ModelId } from './model-id.js';
import type { ModelReasoning, ModelDescriptor } from './model-descriptor.js';
import type { NanoUSD } from './nano-usd.js';
import type { ReasoningPlanModel } from './estimate/reasoning-plan.js';

/** The catalog dates a model in seconds; this module compares milliseconds. */
const MS_PER_SECOND = 1000;

export interface PriceableModel {
  readonly modelId: ModelId;
  /** Billable (fee-inclusive) nano-USD per input token. */
  readonly inputRateNanoUsd: NanoUSD;
  /** Billable (fee-inclusive) nano-USD per output token. */
  readonly outputRateNanoUsd: NanoUSD;
  readonly contextLength: number;
  /** Catalog max output tokens; absent ⇒ the context length alone bounds. */
  readonly providerCap: number | undefined;
  readonly reasoning: ModelReasoning | undefined;
  /**
   * Release timestamp in milliseconds. Required, not optional: the catalog
   * excludes a model whose release date is unknown, so a priceable model always
   * has one, and an optional field would invite a recency verdict on a model
   * with no release date.
   */
  readonly releasedAtMs: number;
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
    modelId: modelId(descriptor.id),
    inputRateNanoUsd: nanoUSD(rates.inputPerToken),
    outputRateNanoUsd: nanoUSD(rates.outputPerToken),
    contextLength,
    providerCap: validCap(descriptor.limits['maxOutputTokens']),
    reasoning: descriptor.reasoning,
    // The catalog dates a model in seconds; every comparison in this module is
    // in milliseconds, and this is the one place the two units meet.
    releasedAtMs: descriptor.releasedAt * MS_PER_SECOND,
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
