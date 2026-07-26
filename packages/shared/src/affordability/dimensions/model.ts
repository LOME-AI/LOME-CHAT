/**
 * The model dimension's registry entry.
 *
 * The model dimension is the carrier of the answer source: pinned when the user
 * selects specific models, open when a Smart Model slot is present. Each model
 * contributes exactly ONE option — itself — so a candidate pool's option set is
 * the union of the pool's self-options, and every per-option fact stays a fact
 * about that model's own catalog row.
 *
 * Its requirement is the model's combined billable per-token RATE — input plus
 * output — declared as the `moneyPerToken` resource. A requirement is
 * denominated in its dimension's resource, and the rate is the nano-USD quantity
 * this layer can state: a property of the model's own catalog row, needing
 * neither a balance nor a prompt to compute.
 *
 * The rate is NOT the candidate order of §Smart Model 1. That order is on turn
 * cost with an identifier tiebreak — §Predicates fixes the quantity as
 * `maxCallCost(m)`, whose input leg is prompt-weighted, whose output leg carries
 * storage, and whose ceiling is capped per model — none of which a rate carries.
 * Which quantity a candidate pool ranks by belongs to whoever builds the pool,
 * not to this entry.
 *
 * A rate, not an amount, because the amount does not exist at this layer: an
 * option's cost is `cost(m, ceiling(m))`, the ceiling depends on the funding,
 * and the funding is the producer's. That circularity is why §The hold writes an
 * open model dimension's term as `MAX over candidates cost(m, ceiling(m))`
 * rather than as a per-option constant, and why the resource is `moneyPerToken`:
 * the type stops a rate from being added to a hold as money.
 *
 * The domain declares no `values`: the option set is the catalog, finite per
 * turn but not expressible as a literal list. It is still `enumerable` — a turn
 * presents a closed candidate set — which is what lets the model dimension be
 * opened at all.
 */

import { combinedRateNanoUsd } from '../premium.js';
import type { PriceableModel } from '../priceable-model.js';
import type { DimensionSpec, DimensionSupport, OptionId, ProviderParams } from './types.js';

function modelSupport(model: PriceableModel): DimensionSupport {
  // Label === id deliberately: the classifier must answer with the identifier
  // it was shown, so this dimension has no separate display word to leak.
  return {
    options: [{ optionId: model.modelId, label: model.modelId }],
    mandatory: false,
  };
}

function assertOwnOption(model: PriceableModel, option: OptionId): void {
  if (option !== model.modelId) {
    throw new RangeError(`model '${model.modelId}' does not offer model option '${option}'`);
  }
}

function modelRequirement(model: PriceableModel, option: OptionId): bigint {
  assertOwnOption(model, option);
  return combinedRateNanoUsd(model);
}

function modelWire(model: PriceableModel, option: OptionId): ProviderParams {
  assertOwnOption(model, option);
  return { model: option };
}

export const MODEL_DIMENSION: DimensionSpec = {
  id: 'model',
  param: { type: 'string', wire: 'firstClass' },
  resource: 'moneyPerToken',
  costClass: 'additive',
  ordered: true,
  enumerable: true,
  support: modelSupport,
  requirement: modelRequirement,
  wire: modelWire,
  resolution: 'nearestBelow',
  promptDescription: "Which model should answer the user's next message.",
  deliversAtHoldCeiling: true,
};
