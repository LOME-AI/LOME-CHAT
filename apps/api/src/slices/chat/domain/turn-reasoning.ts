import { planReasoning, planReasoningOff, reasoningPlanModelFrom } from '@hushbox/shared';
import { validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type {
  CanonicalReasoningEffort,
  ModelDescriptor,
  ReasoningEffortSelection,
  ReasoningWire,
} from '@hushbox/shared';

/**
 * One model's resolved reasoning for a turn: the provider wire config plus the
 * reasoning token budget (B) the answer cap and admission hold add as a
 * CONSTANT term. Both come from the ONE shared plan (`planReasoning`) — no
 * other code path derives a reasoning wire or budget.
 */
export interface TurnReasoningEntry {
  /** The resolved canonical label, or `none` for the hard-off entry (B = 0). */
  readonly effort: CanonicalReasoningEffort | 'none';
  readonly wire: ReasoningWire;
  readonly reasoningBudgetTokens: number;
}

/** The turn's resolved reasoning, keyed by model id (multi-model turns differ per model). */
export type TurnReasoningByModel = ReadonlyMap<string, TurnReasoningEntry>;

/**
 * The deterministic placeholder order `auto` resolves through on the paths
 * the classifier stage does NOT own: multi-model fan-outs, web-search turns
 * (the composite smartModel node carries no tool loop), trial sends, and any
 * pinned turn the auto-effort build falls back from. A pinned single-model
 * paid text turn routes to the classifier stage instead
 * (`compileAutoEffortTurn`), which replaces this placeholder with a
 * classified level at runtime. Order: `medium` (the classifier's own
 * unresolvable-output fallback), then the remaining mid-ladder levels. The
 * first label the shared plan accepts for the model wins; membership is the
 * model's offered positional ladder — an unoffered label is skipped, never
 * nearest-mapped. Every non-empty ladder contains High (N=1 → [High]), so
 * the order needs no Lite/Max entries to always land somewhere.
 */
export const AUTO_REASONING_EFFORT_ORDER: readonly CanonicalReasoningEffort[] = [
  'medium',
  'high',
  'low',
];

/**
 * The plan entry for one (model, level), or undefined when the shared plan
 * reports the pair infeasible. The probe headroom of 1 is the minimum the
 * plan accepts; B and the wire are headroom-independent, so the entry is
 * exact regardless of the answer cap sized later.
 */
export function reasoningEntryFor(
  descriptor: ModelDescriptor,
  effort: CanonicalReasoningEffort
): TurnReasoningEntry | undefined {
  const planned = planReasoning(reasoningPlanModelFrom(descriptor), effort, 1);
  if (!planned.feasible) return undefined;
  return {
    effort,
    wire: planned.plan.wire,
    reasoningBudgetTokens: planned.plan.reasoningBudgetTokens,
  };
}

/** The entry for an explicitly requested level, or the typed 400 the plan's refusal maps to (G3). */
export function requiredReasoningEntryFor(
  descriptor: ModelDescriptor,
  effort: CanonicalReasoningEffort
): Result<TurnReasoningEntry, DomainError> {
  const entry = reasoningEntryFor(descriptor, effort);
  if (entry === undefined) {
    return err(
      validationError(`model '${descriptor.id}' does not support reasoning effort '${effort}'`)
    );
  }
  return ok(entry);
}

/** The auto placeholder entry for a reasoning model, or undefined when no canonical level is feasible. */
function autoEntryFor(descriptor: ModelDescriptor): TurnReasoningEntry | undefined {
  if (descriptor.reasoning === undefined) return undefined;
  for (const effort of AUTO_REASONING_EFFORT_ORDER) {
    const entry = reasoningEntryFor(descriptor, effort);
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/**
 * `none` is a HARD off (founder ruling 2026-07-22): every reasoning-capable
 * non-mandatory model gets the explicit `{ enabled: false }` wire — never
 * parameter omission, so `default_enabled` models truly stop reasoning. A
 * non-reasoning model has nothing to turn off (no entry, no refusal); a
 * mandatory-reasoning model refuses the whole turn (upstream rejects
 * disabling it — reported, not dropped).
 */
function offEntries(
  models: readonly string[],
  resolve: ModelPricingResolver
): Result<TurnReasoningByModel, DomainError> {
  const entries = new Map<string, TurnReasoningEntry>();
  for (const model of models) {
    const descriptor = resolve(model);
    if (descriptor?.reasoning === undefined) continue;
    const planned = planReasoningOff(reasoningPlanModelFrom(descriptor), 1);
    if (!planned.feasible) {
      return err(validationError(`model '${model}' cannot disable its mandatory reasoning`));
    }
    entries.set(model, {
      effort: 'none',
      wire: planned.plan.wire,
      reasoningBudgetTokens: planned.plan.reasoningBudgetTokens,
    });
  }
  return ok(entries);
}

/**
 * Resolves the request's reasoning selection against every model of a text
 * turn, via the ONE shared plan. Infeasible explicit levels are REPORTED as a
 * typed validation error (a client-facing 400) — never silently downgraded,
 * clamped, or substituted:
 *
 * - absent → no reasoning (today's turn, unchanged — an empty map);
 * - `none` → the explicit hard-off wire per reasoning-capable model
 *   ({@link offEntries}), refused on a mandatory-reasoning model (upstream
 *   rejects disabling it — reported, not dropped);
 * - a level → every model must offer it on its positional ladder
 *   (capability + offered-label membership), else the whole turn refuses;
 * - `auto` → the classifier stage's placeholder pick per model
 *   ({@link AUTO_REASONING_EFFORT_ORDER}); a non-reasoning model is a no-op
 *   (no entry, no refusal — auto is the server's choice, and "no reasoning"
 *   is its only honest answer there).
 *
 * An unknown model (absent descriptor) is skipped: the graph compile refuses
 * the turn as an unknown model, the same division of labor as the web-search
 * capability gate.
 */
export function resolveTurnReasoning(
  models: readonly string[],
  resolve: ModelPricingResolver,
  selection?: ReasoningEffortSelection
): Result<TurnReasoningByModel, DomainError> {
  if (selection === undefined) return ok(new Map());
  if (selection === 'none') return offEntries(models, resolve);
  if (selection === 'auto') return ok(autoEntries(models, resolve));
  return levelEntries(models, resolve, selection);
}

/** Every model's auto placeholder entry; non-reasoning and unknown models get none. */
function autoEntries(
  models: readonly string[],
  resolve: ModelPricingResolver
): TurnReasoningByModel {
  const entries = new Map<string, TurnReasoningEntry>();
  for (const model of models) {
    const descriptor = resolve(model);
    if (descriptor === undefined) continue;
    const entry = autoEntryFor(descriptor);
    if (entry !== undefined) entries.set(model, entry);
  }
  return entries;
}

/** Every known model's entry for an explicit level; any refusal fails the whole turn. */
function levelEntries(
  models: readonly string[],
  resolve: ModelPricingResolver,
  level: CanonicalReasoningEffort
): Result<TurnReasoningByModel, DomainError> {
  const entries = new Map<string, TurnReasoningEntry>();
  for (const model of models) {
    const descriptor = resolve(model);
    if (descriptor === undefined) continue;
    const entry = requiredReasoningEntryFor(descriptor, level);
    if (entry.isErr()) return err(entry.error);
    entries.set(model, entry.value);
  }
  return ok(entries);
}
