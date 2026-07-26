/**
 * The turn's effort choice set and its per-model resolution — the ONE shared
 * authority for both (client menu / classifier options / server validation
 * all derive from here; One Implementation, Shared).
 *
 * A multi-model turn offers the UNION of the selected models' positional
 * ladders (`offeredLevels` stays the sole normalization authority — never
 * re-derived here), plus Min (reasoning off) when any model can disable.
 * Per-model resolution is downgrade-only: a model lacking the chosen level
 * falls to its nearest offered rung below; below the whole ladder resolves
 * to off when disabling is possible, and to the LOWEST offered rung on a
 * mandatory-reasoning model — the sole upward exception, because downward
 * is impossible. Single-model explicit picks are NOT resolved through this
 * module: an explicitly chosen level on a single-model turn runs as asked
 * or refuses (`planReasoning`'s G3 refusal), never silently substituted.
 */

import { CANONICAL_REASONING_EFFORTS, REASONING_OFF } from '../reasoning-effort.js';
import {
  offeredLevels,
  planReasoningOff,
  reasoningBudgetForWire,
  validCap,
} from './reasoning-plan.js';
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
 * - `default` — send no reasoning wire at all: the model offers no choice
 *   (not reasoning-capable, or mandatory with a single-level vocabulary
 *   that reasons at the provider default).
 */
export type ResolvedEffort =
  | { readonly kind: 'level'; readonly level: OfferedLevel }
  | { readonly kind: 'off' }
  | { readonly kind: 'default' };

/**
 * Whether the model accepts an explicit reasoning-off wire — delegated to
 * the plan's own off gate so the predicate can never drift from what the
 * wire path actually accepts (headroom of 1 is the minimal valid probe).
 */
function canDisableReasoning(model: ReasoningPlanModel): boolean {
  return planReasoningOff(model, 1).feasible;
}

function ladderPosition(label: CanonicalReasoningEffort): number {
  return CANONICAL_REASONING_EFFORTS.indexOf(label);
}

/**
 * Per-model downgrade resolution of the turn's chosen effort (multi-model
 * union semantics — see the module doc for the single-model G3 carve-out).
 * {@link REASONING_OFF} sits below every rung, so the same nearest-below walk
 * covers Min.
 */
export function resolveEffortForModel(
  model: ReasoningPlanModel,
  chosen: EffortChoice
): ResolvedEffort {
  const offered = offeredLevels(model);
  const chosenPosition = chosen === REASONING_OFF ? -1 : ladderPosition(chosen);
  // offeredLevels is ascending, so findLast is the nearest rung at or below.
  const nearestBelow = offered.findLast((level) => ladderPosition(level.label) <= chosenPosition);
  if (nearestBelow !== undefined) return { kind: 'level', level: nearestBelow };
  if (canDisableReasoning(model)) return { kind: 'off' };
  const lowest = offered[0];
  if (lowest !== undefined) return { kind: 'level', level: lowest };
  return { kind: 'default' };
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
    ...(models.some((model) => canDisableReasoning(model)) ? ([REASONING_OFF] as const) : []),
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
