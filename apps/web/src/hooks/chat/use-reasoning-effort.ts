import { SMART_MODEL_ID } from '@hushbox/shared';
import { turnEffortOptions } from '@hushbox/shared/affordability/estimate/effort-options';
import { useModels } from '@/hooks/models/models';
import { useModelStore } from '@/stores/model';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import type { ModelReasoning, ReasoningEffortSelection } from '@hushbox/shared';

/**
 * The structural slice of a wire catalog `Model` the reasoning derivations
 * read — exactly the shared plan's `ReasoningPlanModel` plus the id. A full
 * `Model` row satisfies it directly (top-level `contextLength` and
 * `maxOutputTokens`). `maxOutputTokens` is declared explicitly — the shared
 * option authority's completion-cap term reads it, and an undeclared field
 * would silently type-erase at this seam even though the runtime object
 * carries it.
 */
export interface EffortModel {
  readonly id: string;
  readonly reasoning?: ModelReasoning | undefined;
  readonly contextLength: number;
  readonly maxOutputTokens?: number | undefined;
}

/**
 * Min (the explicit hard off) is offered only when no selected model has
 * mandatory reasoning — the server refuses disabling a mandatory model, so
 * the option is hidden there (founder ruling), never greyed.
 */
export function offersEffortOff(models: readonly EffortModel[]): boolean {
  return models.every((model) => model.reasoning?.mandatory !== true);
}

export interface EffectiveSelectionInput {
  readonly preferred: ReasoningEffortSelection;
  /** Catalog rows for every selected model id; undefined while unresolved. */
  readonly models: readonly EffortModel[] | undefined;
  readonly modality: string;
}

/**
 * Clamp the persisted preference to what the current selection can honor —
 * the value that actually rides the turn request. `undefined` means "send
 * nothing" (today's reasoning-free turn): non-text modalities and the Smart
 * Model sentinel refuse engaged reasoning server-side (T7 relaxes
 * smart+auto later), and a selection with no offered levels has nothing to
 * engage. A level no model ladder offers — and the off rung against a
 * mandatory-reasoning model — clamps to `auto` (the server's own choice),
 * never to a substituted level.
 */
export function effectiveReasoningSelection(
  input: EffectiveSelectionInput
): ReasoningEffortSelection | undefined {
  const { preferred, models, modality } = input;
  if (modality !== 'text') return undefined;
  if (models === undefined) return undefined;
  if (models.some((model) => model.id === SMART_MODEL_ID)) return undefined;
  // The UNION, not the intersection: per-model resolution falls downward, so a
  // level only one sibling names is still honourable by the turn. The producer
  // grades every rung in that union and the menu greys what it refuses — an
  // intersection here would have hidden a level the server accepts, and enabled
  // one the producer refuses (both directions were live before this).
  const offered = turnEffortOptions(models).map((option) => option.choice);
  if (offered.length === 0) return undefined;
  if (preferred === 'auto') return 'auto';
  if (preferred === 'off') return offersEffortOff(models) ? 'off' : 'auto';
  return offered.includes(preferred) ? preferred : 'auto';
}

export interface ReasoningEffortState {
  /** Raw persisted preference (default `auto`). */
  preferred: ReasoningEffortSelection;
  /** Model-clamped selection for the turn request; undefined = omit the field. */
  effective: ReasoningEffortSelection | undefined;
  /** Catalog rows of the selected models, or undefined while unresolved. */
  models: readonly EffortModel[] | undefined;
  setSelection: (selection: ReasoningEffortSelection) => void;
}

/** Resolve the active selection's ids to catalog rows; undefined until all resolve. */
function resolveSelectedModels(
  selected: readonly { id: string }[],
  catalog: readonly EffortModel[] | undefined
): readonly EffortModel[] | undefined {
  if (catalog === undefined) return undefined;
  const rows: EffortModel[] = [];
  for (const entry of selected) {
    const row = catalog.find((model) => model.id === entry.id);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return rows;
}

/**
 * Single source of truth for the reasoning-effort selection (mirrors
 * `useWebSearch`): the persisted preference plus the per-model clamped
 * effective value every consumer — the effort menu's checked item, the budget
 * estimate, and the send path — reads from here, so the clamp rules have
 * exactly one definition and cannot drift.
 */
export function useReasoningEffort(): ReasoningEffortState {
  const preferred = useReasoningEffortStore((state) => state.preferredReasoningEffort);
  const setSelection = useReasoningEffortStore((state) => state.setReasoningEffort);
  const modality = useModelStore((state) => state.activeModality);
  const selected = useModelStore((state) => state.selections[state.activeModality]);
  const { data } = useModels();

  const models = resolveSelectedModels(selected, data?.models);
  return {
    preferred,
    effective: effectiveReasoningSelection({ preferred, models, modality }),
    models,
    setSelection,
  };
}
