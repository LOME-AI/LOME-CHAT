/**
 * The turn's effort choice set, and the ONE shared authority for it (client
 * menu / classifier options / server validation all derive from here; One
 * Implementation, Shared).
 *
 * A multi-model turn offers the UNION of the selected models' positional
 * ladders (`offeredLevels` stays the sole normalization authority — never
 * re-derived here), plus Min (reasoning off) when any model can disable.
 *
 * Per-model resolution is NOT implemented here. `resolveEffortForModel` is a
 * projection of the registry's one resolver onto this module's `ResolvedEffort`
 * shape: the rule (downward-only, with the mandatory lowest-rung carve-out)
 * lives in `dimensions/derive.ts` and is declared by the effort dimension's
 * `resolution` field, so a second nearest-below walk cannot exist to drift from
 * it. Single-model explicit picks are not resolved through this module at all:
 * an explicitly chosen level on a single-model turn runs as asked or refuses
 * (`planReasoning`'s refusal), never silently substituted.
 */

import { resolveOption } from '../dimensions/derive.js';
import { EFFORT_DIMENSION, effortSupportOf } from '../dimensions/effort.js';
import { CANONICAL_REASONING_EFFORTS, REASONING_OFF } from '../reasoning-effort.js';
import { offeredLevels, reasoningBudgetForWire, validCap } from './reasoning-plan.js';
import type { CanonicalReasoningEffort, ReasoningOff } from '../reasoning-effort.js';
import type { OfferedLevel, ReasoningPlanModel } from './reasoning-plan.js';

/**
 * One entry of the turn's real choice set: a canonical rung or
 * {@link REASONING_OFF} (displayed as Min — reasoning off). `auto` is a
 * selection, not a choice — it never appears here; the menu prepends it and
 * the classifier enumerates exactly these choices.
 */
export type EffortChoice = CanonicalReasoningEffort | ReasoningOff;

export interface EffortOption {
  readonly choice: EffortChoice;
  /**
   * The largest reasoning budget any selected model runs at under this
   * choice, after per-model downgrade resolution and catalog clamps — the
   * B term of the turn's shared headroom sizing. Min is 0 unless a
   * mandatory sibling is forced up to its lowest rung.
   */
  readonly maxReasoningBudgetTokens: number;
  /**
   * The tightest declared provider completion ceiling (`maxOutputTokens`)
   * across the selection — the cap term the headroom `min()` must carry
   * alongside balance-affordable output and context headroom. Undefined
   * when no selected model declares a valid cap; identical on every option
   * of one turn (every sibling answers regardless of the effort choice).
   */
  readonly completionCapTokens: number | undefined;
}

/**
 * How one model runs the turn's chosen effort:
 * - `level` — engage at the offered rung (label + exact wire from the
 *   model's positional ladder); feed `planReasoning`.
 * - `off` — explicit hard off; feed `planReasoningOff`.
 * - `default` — send no reasoning wire at all: the model is not
 *   reasoning-capable, so there is nothing to wire.
 *
 * A mandatory model with a single native word resolves to `level`, not to
 * `default`: its one rung carries a real budget the provider will spend, so it
 * is wired and priced explicitly rather than left to the provider default
 * (§Predicates — eligibility is graded on a reachable corner).
 */
export type ResolvedEffort =
  | { readonly kind: 'level'; readonly level: OfferedLevel }
  | { readonly kind: 'off' }
  | { readonly kind: 'default' };

/**
 * Whether Min is one of the model's own options — read off the registry support
 * rather than re-probed here, so the menu's Min row and the resolver's off rung
 * are the same fact rather than two predicates that agree today.
 */
function offersMin(model: ReasoningPlanModel): boolean {
  return effortSupportOf(model).options.some((option) => option.optionId === REASONING_OFF);
}

/**
 * Per-model resolution of the turn's chosen effort, projected from the registry
 * onto the three wire shapes this module's consumers switch on.
 *
 * The mapping is total and lossless in both directions: the off option becomes
 * the hard-off wire, a rung becomes its own offered level, and the registry's
 * "this model offers nothing on the axis" — which it expresses as no resolved
 * option — becomes the wire-silence arm. That last arm is the one thing the
 * registry's return type does not carry, which is why the projection exists
 * rather than the consumers calling `resolveOption` themselves.
 */
export function resolveEffortForModel(
  model: ReasoningPlanModel,
  chosen: EffortChoice
): ResolvedEffort {
  const resolved = resolveOption(EFFORT_DIMENSION, effortSupportOf(model), chosen);
  if (resolved === undefined) return { kind: 'default' };
  if (resolved === REASONING_OFF) return { kind: 'off' };
  const level = offeredLevels(model).find((offered) => offered.label === resolved);
  /* v8 ignore next -- unreachable: `resolveOption` only ever returns an option the
     support presented, and every non-off option in the effort support is a rung
     read off this same ladder */
  if (level === undefined) return { kind: 'default' };
  return { kind: 'level', level };
}

function resolvedBudgetTokens(model: ReasoningPlanModel, chosen: EffortChoice): number {
  const resolved = resolveEffortForModel(model, chosen);
  return resolved.kind === 'level' ? reasoningBudgetForWire(model, resolved.level.wire) : 0;
}

/**
 * The turn's real choice set, ascending Min → Max. Empty when nothing is
 * selected or no selected model reasons (the menu hides, the server has
 * nothing to validate).
 */
export function turnEffortOptions(models: readonly ReasoningPlanModel[]): EffortOption[] {
  const declaredCaps = models
    .map((model) => validCap(model.maxOutputTokens))
    .filter((cap): cap is number => cap !== undefined);
  const completionCapTokens = declaredCaps.length === 0 ? undefined : Math.min(...declaredCaps);
  const union = new Set(
    models.flatMap((model) => offeredLevels(model).map((level) => level.label))
  );
  const choices: EffortChoice[] = [
    ...(models.some((model) => offersMin(model)) ? ([REASONING_OFF] as const) : []),
    ...CANONICAL_REASONING_EFFORTS.filter((label) => union.has(label)),
  ];
  return choices.map((choice) => ({
    choice,
    maxReasoningBudgetTokens: Math.max(
      0,
      ...models.map((model) => resolvedBudgetTokens(model, choice))
    ),
    completionCapTokens,
  }));
}

/**
 * The intersection gate the client's explicit-level clamp reads: the labels
 * EVERY selected model offers, empty when any model offers nothing. This is
 * the every-model precondition of today's explicit-level sends; the turn's
 * user-facing choice set is `turnEffortOptions` (union semantics), not this.
 */
export function offeredEffortLabels(
  models: readonly ReasoningPlanModel[]
): readonly CanonicalReasoningEffort[] {
  if (models.length === 0) return [];
  const ladders = models.map((model) => offeredLevels(model).map((level) => level.label));
  if (ladders.some((ladder) => ladder.length === 0)) return [];
  return CANONICAL_REASONING_EFFORTS.filter((label) =>
    ladders.every((ladder) => ladder.includes(label))
  );
}
