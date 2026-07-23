import { z } from 'zod';

/**
 * The canonical, model-agnostic reasoning-effort LABEL ladder, ascending
 * (Lite < Low < Medium < High < Max). This is the ONE effort enum every layer
 * imports — request schema, classifier output, the reasoning token plan, and
 * the UI. Labels are POSITIONS, not upstream words: `offeredLevels` in the
 * reasoning plan normalizes each model's native vocabulary (`xhigh`,
 * `minimal`, …) onto this ladder positionally, so a label always maps to a
 * real native level or budget tier for the model at hand — never widened or
 * nearest-mapped here (founder ruling 2026-07-22). The bottom rung is `lite`,
 * not `min` (founder rulings 2026-07-23): the OFF row displays as "Min", so a
 * Min effort level would collide with it — "Lite" is the fifth level's word.
 * The ladder reads Lite < Low < Medium < High < Max.
 */
export const CANONICAL_REASONING_EFFORTS = ['lite', 'low', 'medium', 'high', 'max'] as const;

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

/**
 * Display labels for every selection; `none` reads as "Min" (founder-ruled
 * copy 2026-07-23: "None" implied "no response" — the off row shows the
 * minimum-effort word instead, while the selection value and its
 * `{ enabled: false }` wire stay `none`, unchanged). Every label is ≤4
 * characters so the effort menu always shows the full word without
 * abbreviation (founder-ruled effort-UI copy) — `medium` displays as "Mid"
 * while the enum value stays `medium` on the wire.
 */
export const REASONING_EFFORT_LABELS: Readonly<Record<ReasoningEffortSelection, string>> = {
  auto: 'Auto',
  lite: 'Lite',
  low: 'Low',
  medium: 'Mid',
  high: 'High',
  max: 'Max',
  none: 'Min',
};
