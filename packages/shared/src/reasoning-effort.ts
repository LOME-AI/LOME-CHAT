import { z } from 'zod';

/**
 * The canonical, model-agnostic reasoning-effort LABEL ladder, ascending
 * (Min < Low < Medium < High < Max). This is the ONE effort enum every layer
 * imports — request schema, classifier output, the reasoning token plan, and
 * the UI. Labels are POSITIONS, not upstream words: `offeredLevels` in the
 * reasoning plan normalizes each model's native vocabulary (`xhigh`,
 * `minimal`, …) onto this ladder positionally, so a label always maps to a
 * real native level or budget tier for the model at hand — never widened or
 * nearest-mapped here (founder ruling 2026-07-22).
 */
export const CANONICAL_REASONING_EFFORTS = ['min', 'low', 'medium', 'high', 'max'] as const;

export const CanonicalReasoningEffort = z.enum(CANONICAL_REASONING_EFFORTS);

export type CanonicalReasoningEffort = z.infer<typeof CanonicalReasoningEffort>;

/**
 * What a user can pick: `auto` (server classifies the effort), a canonical
 * level, or `none` (reasoning off — rejected upstream on mandatory-reasoning
 * models, so the composer hides it there). The request schema and the client's
 * persisted preference both use this enum.
 */
export const REASONING_EFFORT_SELECTIONS = [
  'auto',
  ...CANONICAL_REASONING_EFFORTS,
  'none',
] as const;

export const ReasoningEffortSelection = z.enum(REASONING_EFFORT_SELECTIONS);

export type ReasoningEffortSelection = z.infer<typeof ReasoningEffortSelection>;

/** Display labels for every selection; `none` reads as "None" (founder-ruled copy). */
export const REASONING_EFFORT_LABELS: Readonly<Record<ReasoningEffortSelection, string>> = {
  auto: 'Auto',
  min: 'Min',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
  none: 'None',
};
