import { resolveClassifierOutput } from './resolve.js';
import { CANONICAL_REASONING_EFFORTS } from '../reasoning-effort.js';
import {
  offeredLevels,
  planReasoning,
  reasoningBudgetForWire,
} from '../estimate/reasoning-plan.js';
import type { CanonicalReasoningEffort } from '../reasoning-effort.js';
import type { ReasoningPlan, ReasoningPlanModel } from '../estimate/reasoning-plan.js';

/**
 * The effort dimension of the generalized classifier stage (D3): the
 * classifier judges effort on this canonical, model-agnostic scale — never a
 * model's native vocabulary. Mapping onto the resolved model's offered
 * ladder is positional and happens AFTER classification
 * ({@link pickClassifiedEffortPlan}).
 */
export const CLASSIFIER_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export type ClassifierEffortLevel = (typeof CLASSIFIER_EFFORT_LEVELS)[number];

/**
 * Resolve the classifier's free-form effort output to a canonical level via
 * the same fuzzy closed-set matcher the model dimension uses, or `null` when
 * nothing matches confidently (the caller falls back to `medium` — the
 * charge stands, mirroring the model dimension's unresolvable precedent).
 */
export function resolveClassifiedEffort(raw: string): ClassifierEffortLevel | null {
  const resolved = resolveClassifierOutput(raw, CLASSIFIER_EFFORT_LEVELS);
  return resolved === null ? null : (resolved as ClassifierEffortLevel);
}

export interface ClassifierAnswerParts {
  readonly modelText: string;
  readonly effortText: string;
}

/**
 * Split one classifier generation's answer into per-dimension texts. A
 * single-dimension call owns the whole answer; a both-dimensions call is
 * instructed to reply in two lines (model first, effort second), so each
 * dimension takes its designated non-empty line. A missing effort line
 * yields '' — downstream resolution then falls back to `medium` rather than
 * guessing from the model line.
 */
export function parseClassifierAnswer(
  answer: string,
  dimensions: { readonly model: boolean; readonly effort: boolean }
): ClassifierAnswerParts {
  if (dimensions.model && dimensions.effort) {
    const lines = answer
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { modelText: lines[0] ?? '', effortText: lines[1] ?? '' };
  }
  if (dimensions.effort) return { modelText: '', effortText: answer };
  return { modelText: answer, effortText: '' };
}

/** A label's position on the canonical Lite < Low < Medium < High < Max ladder. */
function ladderPosition(label: CanonicalReasoningEffort): number {
  return CANONICAL_REASONING_EFFORTS.indexOf(label);
}

/**
 * Map a classified canonical level onto the resolved model's offered ladder
 * and carve its plan out of an already-reserved completion cap.
 *
 * The mapping is POSITIONAL, never plan-level substitution (the plan itself
 * stays exact-membership per G3): offered labels are ordered by distance
 * from the classified level, ties preferring the LOWER (cheaper) position,
 * and the first label whose reasoning budget leaves at least one answer
 * token inside `completionCapTokens` wins. The returned plan's `maxTokens`
 * ALWAYS equals `completionCapTokens` — the cap the admission hold already
 * priced — so a classified pick can never spend past its reserve.
 *
 * `undefined` = no offered level fits (non-reasoning model, empty ladder, or
 * a cap too small for any budget): the answer runs reasoning-free. This is
 * the classifier stage's own documented choice for `auto` — the server picks
 * a feasible level; it is NOT a silent downgrade of a user-requested level.
 */
export function pickClassifiedEffortPlan(
  model: ReasoningPlanModel,
  classified: ClassifierEffortLevel,
  completionCapTokens: number
): ReasoningPlan | undefined {
  if (!Number.isSafeInteger(completionCapTokens) || completionCapTokens < 2) return undefined;
  const target = ladderPosition(classified);
  const ordered = offeredLevels(model).toSorted((a, b) => {
    const distanceA = Math.abs(ladderPosition(a.label) - target);
    const distanceB = Math.abs(ladderPosition(b.label) - target);
    if (distanceA !== distanceB) return distanceA - distanceB;
    return ladderPosition(a.label) - ladderPosition(b.label);
  });
  for (const level of ordered) {
    // Offered-ladder budgets sit on or above the 1024 protocol floor, so only
    // the cap check can exclude a level here.
    const budget = reasoningBudgetForWire(model, level.wire);
    if (budget + 1 > completionCapTokens) continue;
    const planned = planReasoning(model, level.label, completionCapTokens - budget);
    if (planned.feasible) return planned.plan;
  }
  return undefined;
}
