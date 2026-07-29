import * as React from 'react';
import { useModelStore } from '@/stores/model';
import { usePayerPremiumAccess } from '@/hooks/models/use-payer-premium-access.js';
import { useModels } from '@/hooks/models/models.js';
import type { Model, ChatModality } from '@hushbox/shared';
import type { SelectedModelEntry } from '@/stores/model';

interface ResolveParams {
  modality: ChatModality;
  currentSelection: SelectedModelEntry[];
  models: Model[];
  premiumIds: Set<string>;
  canAccessPremium: boolean;
}

/**
 * Computes the default selection for a non-text modality, or `undefined` if no
 * work is needed. Returning `undefined` lets the caller skip a `setState` call.
 */
function resolveDefault(params: ResolveParams): SelectedModelEntry[] | undefined {
  const { modality, currentSelection, models, premiumIds, canAccessPremium } = params;
  if (modality === 'text') return undefined;
  if (currentSelection.length > 0) return undefined;

  const eligible = models.filter(
    (model) => model.modality === modality && (canAccessPremium || !premiumIds.has(model.id))
  );
  if (eligible.length === 0) return undefined;

  // Non-positional default: highest catalog popularity (rank 0 = most used;
  // absent rank sorts last), with a stable model-id tie-break so a catalog
  // reorder can never silently change which model auto-resolves.
  const [candidate] = eligible.toSorted((a, b) => {
    const rankA = a.popularityRank ?? Infinity;
    const rankB = b.popularityRank ?? Infinity;
    // Not a subtraction: Infinity - Infinity is NaN, which corrupts the sort
    // when neither model is ranked.
    if (rankA === rankB) return a.id.localeCompare(b.id);
    return rankA < rankB ? -1 : 1;
  });
  /* v8 ignore next -- eligible is non-empty (guarded above), so toSorted always yields a first entry */
  if (!candidate) return undefined;

  return [{ id: candidate.id, name: candidate.name }];
}

/**
 * Lazily populates `selections[modality]` with a default model the first time a
 * non-text modality is activated. Text is a no-op because the store's subscriber
 * guard always keeps a Smart Model entry in `selections.text`.
 *
 * The default is the highest-ranked eligible model for that modality after
 * premium filtering (catalog popularity, stable model-id tie-break) — never
 * positional, so a catalog reorder cannot change it.
 *
 * `conversationId` names the payer whose tier decides that filter. The resolver
 * runs only while the modality's selection is empty, so a default chosen at the
 * sender's tier inside an owner-funded conversation is never revisited.
 */
export function useResolveDefaultModel(
  modality: ChatModality,
  conversationId: string | null
): void {
  const access = usePayerPremiumAccess(conversationId);
  const { data: modelsData } = useModels();
  const currentSelection = useModelStore((state) => state.selections[modality]);
  const setSelectedModels = useModelStore((state) => state.setSelectedModels);

  React.useEffect(() => {
    if (access.isPending || !modelsData) return;

    const next = resolveDefault({
      modality,
      currentSelection,
      models: modelsData.models,
      premiumIds: modelsData.premiumIds,
      canAccessPremium: access.canAccessPremium,
    });
    if (next) setSelectedModels(modality, next);
  }, [modality, access, modelsData, currentSelection, setSelectedModels]);
}
