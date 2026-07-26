/**
 * The reasoning-effort dimension's registry entry.
 *
 * Effort is the framework's proof that the pinned/open duality works: the same
 * declaration serves a chosen level (pinned) and Auto (open). It is a
 * `partition` dimension — it redistributes an already-priced completion pool
 * between thinking and answering and has zero marginal money cost, which is why
 * the ceiling is priced from `maxB(m)`, a constant of the model rather than of
 * the chosen option (`docs/BILLING.md` §Invariants, the re-partition invariant).
 *
 * Every per-model fact is read from the catalog through `offeredLevels`, the
 * sole positional-normalization authority — never re-derived here. Adding a
 * native effort word to a model's catalog reasoning metadata therefore changes
 * what it offers with no edit to this file.
 */

import {
  offeredLevels,
  planReasoningOff,
  reasoningBudgetForWire,
} from '../estimate/reasoning-plan.js';
import {
  CANONICAL_REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  REASONING_OFF,
} from '../reasoning-effort.js';
import { reasoningPlanModelOf } from '../priceable-model.js';
import { REASONING_OFF_WIRE } from '../estimate/reasoning-plan.js';
import type { OfferedLevel } from '../estimate/reasoning-plan.js';
import type { PriceableModel } from '../priceable-model.js';
import type { DimensionSpec, DimensionSupport, OptionId, ProviderParams } from './types.js';

/**
 * The effort dimension's option domain, ascending: the off rung sits below every
 * canonical level, so one nearest-below walk covers Min. `auto` is a selection,
 * not an option — the classifier is handed exactly these.
 */
export const EFFORT_OPTION_IDS = [REASONING_OFF, ...CANONICAL_REASONING_EFFORTS] as const;

function offeredLevelFor(model: PriceableModel, option: OptionId): OfferedLevel | undefined {
  return offeredLevels(reasoningPlanModelOf(model)).find((level) => level.label === option);
}

function canDisable(model: PriceableModel): boolean {
  return planReasoningOff(reasoningPlanModelOf(model), 1).feasible;
}

function effortSupport(model: PriceableModel): DimensionSupport {
  const levels = offeredLevels(reasoningPlanModelOf(model));
  const rungs = levels.map((level) => ({
    optionId: level.label,
    label: REASONING_EFFORT_LABELS[level.label],
  }));
  const off = canDisable(model)
    ? [{ optionId: REASONING_OFF, label: REASONING_EFFORT_LABELS[REASONING_OFF] }]
    : [];
  return {
    options: [...off, ...rungs],
    // The catalog fact, read directly: `mandatory` means the provider rejects
    // reasoning-off, which is exactly the precondition of the one upward
    // resolution (§Reasoning Effort 10b).
    mandatory: model.reasoning?.mandatory === true,
  };
}

function unofferedError(model: PriceableModel, option: OptionId): Error {
  return new RangeError(`model '${model.modelId}' does not offer effort option '${option}'`);
}

/**
 * B(m, e) — the reasoning budget one option reserves out of `ceiling(m)`, after
 * the catalog clamps and the 1024-token protocol floor. The off rung reserves
 * nothing. Reasoning tokens ARE output tokens, which is why the requirement is
 * denominated in completion tokens rather than money.
 */
function effortRequirement(model: PriceableModel, option: OptionId): number {
  if (option === REASONING_OFF) {
    if (!canDisable(model)) throw unofferedError(model, option);
    return 0;
  }
  const level = offeredLevelFor(model, option);
  if (level === undefined) throw unofferedError(model, option);
  return reasoningBudgetForWire(reasoningPlanModelOf(model), level.wire);
}

function effortWire(model: PriceableModel, option: OptionId): ProviderParams {
  if (option === REASONING_OFF) {
    if (!canDisable(model)) throw unofferedError(model, option);
    return { reasoning: REASONING_OFF_WIRE };
  }
  const level = offeredLevelFor(model, option);
  if (level === undefined) throw unofferedError(model, option);
  return { reasoning: level.wire };
}

/**
 * `maxB(m)` — the largest reasoning budget any option on this model reserves.
 * A constant of the model, not of the chosen option: it is what the ceiling is
 * priced from, so every presented option prices to the same ceiling and effort
 * carries no marginal money cost.
 */
export function maxReasoningBudgetTokens(model: PriceableModel): number {
  const budgets = effortSupport(model).options.map((option) =>
    effortRequirement(model, option.optionId)
  );
  return Math.max(0, ...budgets);
}

/**
 * `e_min(m)` — the cheapest option this model can actually run: the off rung
 * when reasoning can be disabled, otherwise its lowest offered level. A
 * mandatory-reasoning model's cheapest option is not free, which is why
 * eligibility is graded on this resolved corner rather than on an unreachable
 * zero (§Predicates).
 */
export function cheapestEffortOption(model: PriceableModel): OptionId | undefined {
  return effortSupport(model).options[0]?.optionId;
}

export const EFFORT_DIMENSION: DimensionSpec = {
  id: 'effort',
  param: {
    type: 'enum',
    values: [...EFFORT_OPTION_IDS],
    // Reasoning rides `providerOptions`, never a first-class SDK argument.
    wire: 'providerOptions',
  },
  resource: 'completionTokens',
  costClass: 'partition',
  ordered: true,
  enumerable: true,
  support: effortSupport,
  requirement: effortRequirement,
  wire: effortWire,
  resolution: 'lowestOfferedWhenMandatory',
  promptDescription: 'How much reasoning the next reply needs before it answers.',
  deliversAtHoldCeiling: true,
};
