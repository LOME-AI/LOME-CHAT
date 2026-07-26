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
 * The reasoning-off rung's ONE token. It is simultaneously the option id, the
 * wire value and the persisted value — one vocabulary per rung
 * (`docs/BILLING.md` §Reasoning Effort 1, 9): the user-facing word for this
 * rung is the label `Min`, never this token, and there is no separate `none`
 * concept. Referenced rather than re-typed wherever the rung is named, so the
 * three-token drift it replaced cannot reappear one literal at a time.
 *
 * Distinct from OpenRouter's native `"none"` inside `supportedEfforts`, which
 * is upstream vocabulary describing that a model accepts reasoning-off — never
 * one of our ids.
 */
export const REASONING_OFF = 'off' as const;

export type ReasoningOff = typeof REASONING_OFF;

/**
 * What a user can pick: `auto` (server classifies the effort), a canonical
 * level, or {@link REASONING_OFF} (reasoning off — rejected upstream on
 * mandatory-reasoning models, so the composer hides it there). The request
 * schema and the client's persisted preference both use this enum.
 */
export const REASONING_EFFORT_SELECTIONS = [
  'auto',
  ...CANONICAL_REASONING_EFFORTS,
  REASONING_OFF,
] as const;

export const ReasoningEffortSelection = z.enum(REASONING_EFFORT_SELECTIONS);

export type ReasoningEffortSelection = z.infer<typeof ReasoningEffortSelection>;

/**
 * THE id→label mapping, and the only one: ids appear on the wire and in
 * storage, labels appear everywhere a human or the classifier reads an option
 * (`docs/BILLING.md` §Reasoning Effort 1). `medium` displays as "Mid" and
 * {@link REASONING_OFF} as "Min" (founder-ruled copy 2026-07-23: "None"
 * implied "no response", so the off rung shows the minimum-effort word). Every
 * label is ≤4 characters so the effort menu always shows the full word without
 * abbreviation (founder-ruled effort-UI copy).
 *
 * Any surface re-typing one of these words holds a second mapping free to
 * drift; read it from here.
 */
export const REASONING_EFFORT_LABELS: Readonly<Record<ReasoningEffortSelection, string>> = {
  auto: 'Auto',
  lite: 'Lite',
  low: 'Low',
  medium: 'Mid',
  high: 'High',
  max: 'Max',
  [REASONING_OFF]: 'Min',
};
