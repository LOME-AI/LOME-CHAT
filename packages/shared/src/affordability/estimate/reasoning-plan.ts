/**
 * The reasoning token plan: the single place that turns a (model, canonical
 * effort label) pair into provider wire mechanics. No code path may set
 * `reasoning` on a provider call except through this module's output, and
 * infeasible combinations are REPORTED — never silently downgraded, clamped
 * to a different level, or nearest-mapped. Client feasibility gating and
 * server admission both call these same functions (One Implementation,
 * Shared).
 *
 * Labels are POSITIONS on the canonical Lite < Low < Medium < High < Max
 * ladder (founder ruling 2026-07-22): `offeredLevels` normalizes each
 * model's native effort vocabulary onto that ladder positionally, and every
 * consumer — UI rendering, server validation, wire choice — derives the
 * offered set from it.
 */

import { z } from 'zod';

import { CANONICAL_REASONING_EFFORTS } from '../reasoning-effort.js';
import type { CanonicalReasoningEffort } from '../reasoning-effort.js';
import type { ModelReasoning } from '../model-descriptor.js';

/**
 * The OpenRouter/Anthropic protocol floor: a reasoning budget below 1024 is
 * raised to 1024 upstream, so the plan applies the same clamp. This is the
 * ONLY protocol constant in the plan — every cap is catalog data, because
 * upstream caps are volatile (the documented Anthropic cap has already moved
 * once) and must never be hardcoded.
 */
export const REASONING_BUDGET_FLOOR_TOKENS = 1024;

/**
 * Per-label reasoning budgets in tokens — founder-tunable data, not
 * protocol. Placeholder tiers approved 2026-07-22 (low 4k / medium 12k /
 * high 32k / max 64k); Lite's 2048 continues the halving progression below
 * Low while staying above the 1024 protocol floor (placeholder picked with
 * the 2026-07-23 Lite ruling, same tunable-data status).
 */
export const REASONING_BUDGET_TOKENS_BY_EFFORT: Readonly<Record<CanonicalReasoningEffort, number>> =
  {
    lite: 2048,
    low: 4096,
    medium: 12_288,
    high: 32_768,
    max: 65_536,
  };

/**
 * What goes on the provider call, discriminated so the three shapes are
 * mutually exclusive BY TYPE — sending `effort` and `max_tokens` together is
 * invalid upstream, so every branch is `.strict()` and any mixed-keys object
 * fails to parse. `effort` carries the model's NATIVE effort word (the
 * positional mapping's output — `xhigh`, `minimal`, … are legal), never the
 * canonical label vocabulary; budget-native models wire the token budget;
 * `{ enabled: false }` is the hard off — sent explicitly (never expressed as
 * parameter omission) so `default_enabled` models truly stop reasoning.
 * Field names match the gateway body verbatim. This schema is the single
 * wire definition: runtime validators (the adapter's call-parameters schema)
 * compose it rather than re-typing the shape, and the TS type is inferred
 * from it so the two can never drift.
 */
export const ReasoningWire = z
  .union([
    z.strictObject({ effort: z.string().min(1) }),
    z.strictObject({ max_tokens: z.number().int().positive() }),
    z.strictObject({ enabled: z.literal(false) }),
  ])
  // Branded so the schema (and the plan functions built on it) is the ONLY
  // mint: a hand-written wire object literal fails to compile at every
  // consumer, forcing all wires through this module's validation (G1).
  .brand<'ReasoningWire'>();

export type ReasoningWire = z.infer<typeof ReasoningWire>;

/**
 * The minted hard-off wire — the one value stampers may embed as shared node
 * data (the smartModel off shape) without a model in hand; `planReasoningOff`
 * wires this same value.
 */
export const REASONING_OFF_WIRE: ReasoningWire = ReasoningWire.parse({ enabled: false });

export interface ReasoningPlan {
  /** B — tokens reserved for thinking, post floor/cap clamps (0 for the off plan). */
  readonly reasoningBudgetTokens: number;
  /** H — the caller's affordability-derived answer cap, passed through. */
  readonly answerHeadroomTokens: number;
  /**
   * The explicit completion `max_tokens` (= B + H) that MUST accompany every
   * reasoning call: unset behavior is undocumented upstream, and budget-native
   * providers require it to strictly exceed the reasoning budget.
   */
  readonly maxTokens: number;
  readonly wire: ReasoningWire;
}

export type ReasoningInfeasibleReason =
  | 'not-reasoning-capable'
  | 'effort-not-supported'
  | 'reasoning-mandatory'
  | 'no-answer-headroom';

export type ReasoningPlanResult =
  | { readonly feasible: true; readonly plan: ReasoningPlan }
  | { readonly feasible: false; readonly reason: ReasoningInfeasibleReason };

/**
 * The model facts the plan reads. `reasoning` is the structured catalog
 * object — the single authority for effort logic (the legacy `behaviors`
 * flag is never consulted). `contextLength` is the catalog-driven cap the
 * budget clamps to; `maxOutputTokens` is the provider's completion ceiling
 * (ingested from the gateway catalog) — the budget clamps to whichever is
 * tighter; an absent field means that cap does not apply.
 *
 * The client's wire catalog row satisfies this shape directly (top-level
 * `contextLength`/`maxOutputTokens`), but the server descriptor does NOT: its
 * caps live inside `limits`, and because the fields here are optional a
 * descriptor passed directly compiles while silently dropping them. Server
 * callers must build the input via `reasoningPlanModelFrom`.
 */
export interface ReasoningPlanModel {
  readonly reasoning?: ModelReasoning | undefined;
  readonly contextLength?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
}

/**
 * The descriptor-shaped slice `reasoningPlanModelFrom` reads — structurally
 * satisfied by the server's `ModelDescriptor` without importing its full type.
 */
export interface ReasoningPlanDescriptorInput {
  readonly reasoning?: ModelReasoning | undefined;
  readonly limits: Readonly<Record<string, number>>;
}

/**
 * Build the plan's model input from a server descriptor, performing the
 * `limits` mapping so neither cap can be silently dropped.
 */
export function reasoningPlanModelFrom(
  descriptor: ReasoningPlanDescriptorInput
): ReasoningPlanModel {
  return {
    reasoning: descriptor.reasoning,
    contextLength: descriptor.limits['contextLength'],
    maxOutputTokens: descriptor.limits['maxOutputTokens'],
  };
}

/** One rung of a model's offered ladder: the canonical label and its exact wire. */
export interface OfferedLevel {
  readonly label: CanonicalReasoningEffort;
  readonly wire: ReasoningWire;
}

/**
 * The ruled label assignment by offered count N (ascending): 1 → [High];
 * 2 → [Low, High]; 3 → [Low, Medium, High]; 4 → [Low, Medium, High, Max];
 * 5 → [Lite, Low, Medium, High, Max] (founder rulings 2026-07-23). Callers
 * pass N ∈ 1..5 (the caller empty-returns N=0 and slices deeper
 * vocabularies to their strongest five).
 */
function ladderFor(count: number): readonly CanonicalReasoningEffort[] {
  if (count >= CANONICAL_REASONING_EFFORTS.length) return CANONICAL_REASONING_EFFORTS;
  if (count === 4) return ['low', 'medium', 'high', 'max'];
  if (count === 3) return ['low', 'medium', 'high'];
  if (count === 2) return ['low', 'high'];
  return ['high'];
}

/**
 * Native upstream effort words for the full ladder when a model accepts
 * every level without enumerating any (`supportedEfforts: null`): the wire
 * must carry the gateway's universal vocabulary (`minimal` — `lite` is not
 * an upstream word), so canonical labels translate here.
 */
const NATIVE_EFFORT_BY_LABEL: Readonly<Record<CanonicalReasoningEffort, string>> = {
  lite: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
};

/** A catalog cap, floored to whole tokens; non-finite/non-positive values are
 * ignored rather than trusted. */
export function validCap(cap: number | undefined): number | undefined {
  return cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : undefined;
}

/**
 * B = max(min(tier, floor(cap)), 1024) — mirroring the upstream derivation,
 * where the floor wins over the cap. The cap is the TIGHTER of the model's
 * context length and its provider completion ceiling (`maxOutputTokens`,
 * strict tightening — an absent ceiling falls back to the context length
 * alone). A sub-floor cap still yields the 1024 floor; answer-headroom
 * sizing is what refuses a level that cannot fit such a cap.
 */
function clampBudget(tierBudgetTokens: number, model: ReasoningPlanModel): number {
  const caps = [validCap(model.contextLength), validCap(model.maxOutputTokens)].filter(
    (cap): cap is number => cap !== undefined
  );
  const capped = caps.length === 0 ? tierBudgetTokens : Math.min(tierBudgetTokens, ...caps);
  return Math.max(capped, REASONING_BUDGET_FLOOR_TOKENS);
}

/** The full five-rung ladder over a per-label wire builder. */
function fullLadder(wireFor: (label: CanonicalReasoningEffort) => ReasoningWire): OfferedLevel[] {
  return CANONICAL_REASONING_EFFORTS.map((label) => ({ label, wire: wireFor(label) }));
}

/**
 * THE positional-normalization authority (founder ruling 2026-07-22): the
 * ordered (ascending Min→Max) set of levels a model offers, each label bound
 * to its exact provider wire. Every consumer — the effort menu's rendering, server
 * validation, the plan's wire choice — derives from this one function.
 *
 * - No `reasoning` object → nothing offered (reasoning-unsupported model).
 * - Enumerated `supportedEfforts` (upstream DESCENDING order): count N =
 *   non-`none` entries; the N-rung label ladder zips against the reversed
 *   (ascending) natives, so High is always the strongest offered word.
 *   N=0 → nothing; N=1 with `mandatory` → nothing (single option, no off —
 *   no choice exists); a vocabulary beyond five rungs keeps the strongest
 *   five (the ruling defines ladders only to five; truncation drops the
 *   weakest extras so Max stays the true top).
 * - `null` (every effort accepted, none enumerated) → the full ladder over
 *   the gateway's universal effort words.
 * - Absent `supportedEfforts` (budget-native) → the full ladder as clamped
 *   token-budget tiers.
 *
 * `none`/`auto` are selections, not ladder rungs — they never appear here.
 */
export function offeredLevels(model: ReasoningPlanModel): readonly OfferedLevel[] {
  const { reasoning } = model;
  if (reasoning === undefined) return [];
  const { supportedEfforts } = reasoning;
  if (supportedEfforts === undefined) {
    return fullLadder((label) =>
      ReasoningWire.parse({
        max_tokens: clampBudget(REASONING_BUDGET_TOKENS_BY_EFFORT[label], model),
      })
    );
  }
  if (supportedEfforts === null) {
    return fullLadder((label) => ReasoningWire.parse({ effort: NATIVE_EFFORT_BY_LABEL[label] }));
  }
  const natives = supportedEfforts.filter((effort) => effort !== 'none');
  if (natives.length === 0) return [];
  if (natives.length === 1 && reasoning.mandatory === true) return [];
  const shown = natives.slice(0, CANONICAL_REASONING_EFFORTS.length);
  const ascending = shown.toReversed();
  return ladderFor(shown.length).map((label, position) => ({
    label,
    // The zip is index-aligned by construction (ladderFor(n).length === n for
    // n ∈ 1..5); the fallback only satisfies noUncheckedIndexedAccess.
    wire: ReasoningWire.parse({ effort: ascending[position] ?? '' }),
  }));
}

/**
 * Map a (model, canonical label) pair to wire mechanics, or a typed
 * infeasibility. The wire comes from the model's offered ladder
 * ({@link offeredLevels}) — positional, never nearest-mapped: a label the
 * ladder does not offer is reported infeasible (G3).
 *
 * `answerHeadroomTokens` (H) is an input — affordability sizing stays with
 * the existing estimator; the plan only enforces that H leaves the completion
 * cap strictly above the reasoning budget (H ≥ 1 whole token).
 */
export function planReasoning(
  model: ReasoningPlanModel,
  effort: CanonicalReasoningEffort,
  answerHeadroomTokens: number
): ReasoningPlanResult {
  if (model.reasoning === undefined) {
    return { feasible: false, reason: 'not-reasoning-capable' };
  }

  const offered = offeredLevels(model).find((level) => level.label === effort);
  if (offered === undefined) {
    return { feasible: false, reason: 'effort-not-supported' };
  }

  if (!Number.isInteger(answerHeadroomTokens) || answerHeadroomTokens < 1) {
    return { feasible: false, reason: 'no-answer-headroom' };
  }

  const reasoningBudgetTokens =
    'max_tokens' in offered.wire
      ? offered.wire.max_tokens
      : clampBudget(REASONING_BUDGET_TOKENS_BY_EFFORT[effort], model);
  return {
    feasible: true,
    plan: {
      reasoningBudgetTokens,
      answerHeadroomTokens,
      maxTokens: reasoningBudgetTokens + answerHeadroomTokens,
      wire: offered.wire,
    },
  };
}

/**
 * The hard-off plan for the `none` selection: reasoning is disabled with the
 * EXPLICIT `{ enabled: false }` wire — never parameter omission, so
 * `default_enabled` models truly stop reasoning. B = 0 and the completion
 * cap is the answer headroom alone (maxTokens = H). Refused, never silently
 * dropped, on a model whose reasoning cannot be disabled upstream
 * (`mandatory`) or that has no reasoning to turn off.
 */
export function planReasoningOff(
  model: ReasoningPlanModel,
  answerHeadroomTokens: number
): ReasoningPlanResult {
  const { reasoning } = model;
  if (reasoning === undefined) {
    return { feasible: false, reason: 'not-reasoning-capable' };
  }
  if (reasoning.mandatory === true) {
    return { feasible: false, reason: 'reasoning-mandatory' };
  }
  if (!Number.isInteger(answerHeadroomTokens) || answerHeadroomTokens < 1) {
    return { feasible: false, reason: 'no-answer-headroom' };
  }
  return {
    feasible: true,
    plan: {
      reasoningBudgetTokens: 0,
      answerHeadroomTokens,
      maxTokens: answerHeadroomTokens,
      wire: REASONING_OFF_WIRE,
    },
  };
}

/**
 * Re-derive the reasoning budget B from a persisted wire param (the server
 * reads node params back when reconciling answer caps): the off wire is 0, a
 * budget wire carries B verbatim, and an effort wire maps its native word
 * back to its positional label through {@link offeredLevels} before pricing
 * the clamped tier. An unoffered word prices at 0 — fail-safe toward no
 * phantom token allowance, never a silent substitute level.
 */
export function reasoningBudgetForWire(model: ReasoningPlanModel, wire: ReasoningWire): number {
  if ('enabled' in wire) return 0;
  if ('max_tokens' in wire) return wire.max_tokens;
  const offered = offeredLevels(model).find(
    (level) => 'effort' in level.wire && level.wire.effort === wire.effort
  );
  if (offered === undefined) return 0;
  return clampBudget(REASONING_BUDGET_TOKENS_BY_EFFORT[offered.label], model);
}
