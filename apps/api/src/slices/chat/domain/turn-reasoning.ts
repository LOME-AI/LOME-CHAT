import { reasoningPlanModelFrom } from '@hushbox/shared';
import {
  resolveEffortForModel,
  turnEffortOptions,
} from '@hushbox/shared/affordability/estimate/effort-options';
import {
  planReasoning,
  planReasoningOff,
} from '@hushbox/shared/affordability/estimate/reasoning-plan';
import { validationError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type {
  CanonicalReasoningEffort,
  EffortChoice,
  ModelDescriptor,
  ReasoningEffortSelection,
  ReasoningOff,
  ReasoningWire,
} from '@hushbox/shared';

/**
 * One model's resolved reasoning for a turn: the provider wire config plus the
 * reasoning token budget (B) the answer cap and admission hold add as a
 * CONSTANT term. Both come from the ONE shared plan (`planReasoning`) — no
 * other code path derives a reasoning wire or budget.
 */
export interface TurnReasoningEntry {
  /** The resolved canonical label, or `off` for the hard-off entry (B = 0). */
  readonly effort: CanonicalReasoningEffort | ReasoningOff;
  readonly wire: ReasoningWire;
  readonly reasoningBudgetTokens: number;
}

/** The turn's resolved reasoning, keyed by model id (multi-model turns differ per model). */
export type TurnReasoningByModel = ReadonlyMap<string, TurnReasoningEntry>;

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

/**
 * `none` is a HARD off (founder ruling 2026-07-22): every reasoning-capable
 * non-mandatory model gets the explicit `{ enabled: false }` wire — never
 * parameter omission, so `default_enabled` models truly stop reasoning. A
 * non-reasoning model has nothing to turn off (no entry, no refusal); a
 * mandatory-reasoning model refuses the whole turn (upstream rejects
 * disabling it — reported, not dropped). Single-model only: a multi-model
 * Min resolves per sibling through the shared downgrade rule instead
 * (BILLING §Effort 8b — a mandatory sibling runs its lowest rung).
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
      effort: 'off',
      wire: planned.plan.wire,
      reasoningBudgetTokens: planned.plan.reasoningBudgetTokens,
    });
  }
  return ok(entries);
}

/**
 * The known descriptors of a turn's model list, in selected order. Unknown
 * models (absent descriptors) are skipped: the graph compile refuses the turn
 * as an unknown model, the same division of labor as the web-search gate.
 */
function knownDescriptors(
  models: readonly string[],
  resolve: ModelPricingResolver
): readonly (readonly [string, ModelDescriptor])[] {
  const known: (readonly [string, ModelDescriptor])[] = [];
  for (const model of models) {
    const descriptor = resolve(model);
    if (descriptor !== undefined) known.push([model, descriptor]);
  }
  return known;
}

/** The turn's real choice set (union + Min) via the ONE shared authority. */
function turnChoices(
  known: readonly (readonly [string, ModelDescriptor])[]
): readonly EffortChoice[] {
  return turnEffortOptions(known.map(([, descriptor]) => reasoningPlanModelFrom(descriptor))).map(
    (option) => option.choice
  );
}

/**
 * One model's entry for a union choice, resolved through the shared
 * downgrade rule. A `default` resolution is WIRE SILENCE — no entry, no
 * refusal (a non-reasoning model, or a mandatory single-level model that
 * reasons at the provider default) — never an error.
 */
function resolvedEntryFor(
  descriptor: ModelDescriptor,
  chosen: EffortChoice
): TurnReasoningEntry | undefined {
  const resolved = resolveEffortForModel(reasoningPlanModelFrom(descriptor), chosen);
  if (resolved.kind === 'default') return undefined;
  if (resolved.kind === 'off') {
    const planned = planReasoningOff(reasoningPlanModelFrom(descriptor), 1);
    /* v8 ignore next 3 -- defensive: the shared resolution reaches `off` only
       through the same plan-off feasibility gate, so an infeasible plan here
       is a drift defect kept wire-silent rather than assumed impossible */
    if (!planned.feasible) return undefined;
    return {
      effort: 'off',
      wire: planned.plan.wire,
      reasoningBudgetTokens: planned.plan.reasoningBudgetTokens,
    };
  }
  return reasoningEntryFor(descriptor, resolved.level.label);
}

/**
 * A multi-model turn's per-model resolution of a union choice (BILLING
 * §Effort 4, ruled edges 8a/8b): the chosen level must come from the turn's
 * union option set; each sibling then falls to its own nearest offered rung
 * below, to hard off when nothing sits below and it can disable, up to its
 * lowest rung when reasoning is mandatory, or to wire silence when it offers
 * no choice at all. `off` outside the option set (no sibling reasons ⇒
 * empty set) stays the historical no-op; a level with no reasoning sibling
 * anywhere is refused — it cannot have come from an offered menu.
 */
function unionEntries(
  models: readonly string[],
  resolve: ModelPricingResolver,
  chosen: EffortChoice
): Result<TurnReasoningByModel, DomainError> {
  const known = knownDescriptors(models, resolve);
  if (known.length === 0) return ok(new Map());
  const choices = turnChoices(known);
  if (choices.length === 0 && chosen === 'off') return ok(new Map());
  if (!choices.includes(chosen)) {
    return err(
      validationError(`reasoning effort '${chosen}' is outside the selected models' option set`)
    );
  }
  const entries = new Map<string, TurnReasoningEntry>();
  for (const [model, descriptor] of known) {
    const entry = resolvedEntryFor(descriptor, chosen);
    if (entry !== undefined) entries.set(model, entry);
  }
  return ok(entries);
}

/**
 * The deterministic `auto` resolution (BILLING §Effort 5): exactly one real
 * choice in the turn's union option set picks it outright — no classifier
 * call, no reserve (including the Min-only degenerate set). Zero choices is
 * reasoning-free. Two or more real choices belong to the classifier stage;
 * a build that reaches this resolution without one runs reasoning-free —
 * auto is the server's choice, and no static preference order exists.
 */
function autoEntries(
  models: readonly string[],
  resolve: ModelPricingResolver
): TurnReasoningByModel {
  const known = knownDescriptors(models, resolve);
  const choices = turnChoices(known);
  const sole = choices.length === 1 ? choices[0] : undefined;
  if (sole === undefined) return new Map();
  const entries = new Map<string, TurnReasoningEntry>();
  for (const [model, descriptor] of known) {
    const entry = resolvedEntryFor(descriptor, sole);
    if (entry !== undefined) entries.set(model, entry);
  }
  return entries;
}

/** A single model's entry for an explicit level — run as asked or refuse. */
function singleLevelEntries(
  model: string,
  resolve: ModelPricingResolver,
  level: CanonicalReasoningEffort
): Result<TurnReasoningByModel, DomainError> {
  const descriptor = resolve(model);
  if (descriptor === undefined) return ok(new Map());
  return requiredReasoningEntryFor(descriptor, level).map(
    (entry) => new Map([[model, entry]]) as TurnReasoningByModel
  );
}

/**
 * Resolves the request's reasoning selection against every model of a text
 * turn, via the ONE shared plan and the shared union authority:
 *
 * - absent → no reasoning (an empty map);
 * - single model → run as asked or refuse: an explicit level the model
 *   does not offer is a typed validation error (a client-facing 400), never
 *   silently downgraded; `none` is the explicit hard-off wire, refused on a
 *   mandatory-reasoning model ({@link offEntries});
 * - multi-model → the union option set with per-model downgrade resolution
 *   ({@link unionEntries}); a `default` resolution is wire silence;
 * - `auto` → deterministic only ({@link autoEntries}): the sole real choice
 *   when exactly one exists, reasoning-free otherwise — multi-choice auto is
 *   classifier-driven and never resolved here.
 *
 * An unknown model (absent descriptor) is skipped: the graph compile refuses
 * the turn as an unknown model.
 */
export function resolveTurnReasoning(
  models: readonly string[],
  resolve: ModelPricingResolver,
  selection?: ReasoningEffortSelection
): Result<TurnReasoningByModel, DomainError> {
  if (selection === undefined) return ok(new Map());
  if (selection === 'auto') return ok(autoEntries(models, resolve));
  const single = models.length === 1 ? models[0] : undefined;
  if (single !== undefined) {
    if (selection === 'off') return offEntries(models, resolve);
    return singleLevelEntries(single, resolve, selection);
  }
  return unionEntries(models, resolve, selection);
}
