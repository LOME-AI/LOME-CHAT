/**
 * The effort dimension's classifier stage: what the classifier may answer, how
 * one generation's answer splits per dimension, and how the answered option
 * becomes a wire plan inside the cap the hold already paid for.
 *
 * Nothing here implements resolution or presentation. The option set, the
 * labels, the resolution rule and the per-option budget all come from the
 * registry entry (`dimensions/effort.ts` + `dimensions/derive.ts`); this module
 * is the projection of those onto the reasoning-plan shapes the executor sends.
 */

import { dimensionAnswerText, parseDimensionAnswer, resolveOption } from '../dimensions/derive.js';
import {
  EFFORT_DIMENSION,
  effortDomainOptions,
  effortRequirementOf,
  effortSupportOf,
} from '../dimensions/effort.js';
import { MODEL_DIMENSION } from '../dimensions/model.js';
import { REASONING_OFF } from '../reasoning-effort.js';
import { offeredLevels, planReasoning, planReasoningOff } from '../estimate/reasoning-plan.js';
import type { EffortChoice } from '../estimate/effort-options.js';
import type { ReasoningPlan, ReasoningPlanModel } from '../estimate/reasoning-plan.js';

/**
 * What the classifier may answer on the effort axis: the dimension's own option
 * domain, Min through Max. It is the registry's domain rather than a scale of
 * this module's own — the classifier is presented exactly the options a user
 * sees, in the user's own labels (`docs/BILLING.md` §Reasoning Effort 6), so a
 * separate classifier-only vocabulary would be a second ladder to keep aligned.
 */
export type ClassifierEffortLevel = EffortChoice;

/**
 * Resolve the classifier's free-form effort output to an option id via the
 * registry's own label matcher, or `null` when nothing matches confidently (the
 * caller then applies the declared fallback — the charge stands, mirroring the
 * model dimension's unresolvable precedent).
 */
export function resolveClassifiedEffort(raw: string): ClassifierEffortLevel | null {
  const matched = parseDimensionAnswer(
    EFFORT_DIMENSION,
    { options: effortDomainOptions(), mandatory: false },
    raw
  );
  return matched === undefined ? null : (matched as ClassifierEffortLevel);
}

/**
 * The effort axis's CHEAPEST option — §Reasoning Effort 8's declared fallback
 * for an answer that resolves to nothing.
 *
 * It is read off the dimension's own domain order, which is ascending, rather
 * than named as a constant: a named rung would be a second answer to a question
 * the registry already answers, free to drift from it. Per-model resolution
 * maps it onto each model's ladder afterwards, so "the axis's cheapest" becomes
 * "this model's cheapest" without a per-model fallback of its own.
 */
export function cheapestClassifierEffort(): ClassifierEffortLevel {
  const cheapest = effortDomainOptions()[0]?.optionId;
  /* v8 ignore next -- the effort domain is a non-empty literal tuple, so its
     first entry always exists; the guard only narrows the lookup */
  if (cheapest === undefined) throw new Error('the effort dimension declares no options');
  return cheapest as ClassifierEffortLevel;
}

export interface ClassifierAnswerParts {
  readonly modelText: string;
  readonly effortText: string;
}

/**
 * Split one classifier generation's answer into per-dimension texts.
 *
 * The prompt instructs one labelled line per dimension, and each dimension takes
 * its own labelled line — never a positional one. Labels rather than positions
 * are what let a dimension be added without breaking the parsing of the lines
 * already there (§Derived, never declared).
 *
 * A call that classified ONE dimension may also treat an unlabelled answer as
 * that dimension's own, since there is nothing else it could be. A
 * both-dimensions call cannot: an unlabelled answer leaves each dimension with
 * '' and the caller's declared fallback covers it, which is the honest outcome —
 * guessing from line order is how a positional protocol comes back.
 */
export function parseClassifierAnswer(
  answer: string,
  dimensions: { readonly model: boolean; readonly effort: boolean }
): ClassifierAnswerParts {
  const model = dimensionAnswerText(MODEL_DIMENSION, answer);
  const effort = dimensionAnswerText(EFFORT_DIMENSION, answer);
  if (dimensions.model && dimensions.effort) {
    return { modelText: model ?? '', effortText: effort ?? '' };
  }
  if (dimensions.effort) return { modelText: '', effortText: effort ?? answer };
  return { modelText: model ?? answer, effortText: '' };
}

/**
 * Carve the classified option's plan out of the completion cap the admission
 * hold already priced.
 *
 * Two steps, and the split matters. Resolution onto the model's own ladder is
 * the registry's, so it is downward-only with the mandatory lowest-rung
 * carve-out — a nearer rung ABOVE the classified option never wins. Then the
 * walk continues DOWNWARD while the resolved option's reasoning budget leaves no
 * whole answer token inside the cap, because a cap can be tighter than the rung
 * the ladder resolved to; the walk cannot turn upward, so a step-down is always
 * cheaper than what the classifier asked for.
 *
 * The returned plan's `maxTokens` is the cap it was HANDED, in every arm — the
 * cap the hold was placed against — so a classified pick can never spend past
 * its reserve (`docs/BILLING.md` §Reasoning Effort 3, §Invariants). It is passed
 * through rather than re-derived, and a property test sweeps the boundary.
 *
 * `undefined` means no reasoning wire is sent at all: the model offers nothing
 * on the axis, or resolution landed on a mandatory ladder's lowest rung with no
 * option below it and a cap too small to hold it.
 */
export function pickClassifiedEffortPlan(
  model: ReasoningPlanModel,
  classified: ClassifierEffortLevel,
  completionCapTokens: number
): ReasoningPlan | undefined {
  if (!Number.isSafeInteger(completionCapTokens) || completionCapTokens < 2) return undefined;
  const support = effortSupportOf(model);
  const resolved = resolveOption(EFFORT_DIMENSION, support, classified);
  if (resolved === undefined) return undefined;
  const options = support.options.map((option) => option.optionId);
  // Ascending support, so the slice up to and including the resolved option is
  // exactly the set at or below it — the only directions the walk may take.
  const downward = options.slice(0, options.indexOf(resolved) + 1).toReversed();
  for (const option of downward) {
    const budget = effortRequirementOf(model, option);
    if (budget + 1 > completionCapTokens) continue;
    return planFor(model, option, budget, completionCapTokens);
  }
  return undefined;
}

function planFor(
  model: ReasoningPlanModel,
  option: string,
  budget: number,
  completionCapTokens: number
): ReasoningPlan | undefined {
  if (option === REASONING_OFF) {
    const off = planReasoningOff(model, completionCapTokens);
    /* v8 ignore next -- unreachable: the off option is present in the support
       only when `planReasoningOff` accepts this model, and the headroom here is
       the whole cap, already checked to be at least one token */
    return off.feasible ? off.plan : undefined;
  }
  const level = offeredLevels(model).find((offered) => offered.label === option);
  /* v8 ignore next -- unreachable: every non-off option in the support is a rung
     read off this same ladder */
  if (level === undefined) return undefined;
  const planned = planReasoning(model, level.label, completionCapTokens - budget);
  /* v8 ignore next -- unreachable: the rung is offered, and the headroom is the
     cap minus this rung's own budget, checked above to leave a whole token */
  return planned.feasible ? planned.plan : undefined;
}
