import * as React from 'react';
import { parseNanoUSD } from '@hushbox/shared';
import { useSession } from '@/lib/auth';
import { useModelStore } from '@/stores/model';
import { useBalance } from '@/hooks/billing/billing.js';
import { useModels, getAccessibleModelIds } from '@/hooks/models/models.js';
import type { Model, LegacyModality, GetBalanceResponse } from '@hushbox/shared';
import type { SelectedModelEntry } from '@/stores/model';
import type { ModelsData } from '@/hooks/models/models.js';

interface ValidationStateParams {
  modelsData: ModelsData | undefined;
  isSessionPending: boolean;
  isAuthenticated: boolean;
  balanceData: GetBalanceResponse | undefined;
}

type ValidationState = { isReady: false } | { isReady: true; canAccessPremium: boolean };

function getValidationState(params: ValidationStateParams): ValidationState {
  const { modelsData, isSessionPending, isAuthenticated, balanceData } = params;

  if (!modelsData) return { isReady: false };
  if (isSessionPending) return { isReady: false };
  if (isAuthenticated && !balanceData) return { isReady: false };

  const purchasedNano = balanceData ? parseNanoUSD(balanceData.purchased.balanceNanoUsd) : 0n;
  const canAccessPremium = isAuthenticated && purchasedNano > 0n;

  return { isReady: true, canAccessPremium };
}

interface ValidateModalityParams {
  modality: LegacyModality;
  current: SelectedModelEntry[];
  models: Model[];
  premiumIds: Set<string>;
  canAccessPremium: boolean;
  textFallback: SelectedModelEntry | undefined;
}

/**
 * Returns the next selection list for a modality, or `undefined` if no change is needed.
 *
 * Drops entries that no longer exist in the API or that the user can't access (premium).
 * For the text modality, empties after filtering are replaced with the strongest
 * accessible text model so the UI always has a primary model to render.
 */
function validateModality(params: ValidateModalityParams): SelectedModelEntry[] | undefined {
  const { modality, current, models, premiumIds, canAccessPremium, textFallback } = params;
  // Empty text is impossible at runtime (subscriber guard + merge restore it);
  // empty image/audio/video is legitimate and is repopulated by useResolveDefaultModel.
  if (current.length === 0) return undefined;

  const validIds = new Set(models.map((m) => m.id));
  const filtered = current.filter(
    (entry) => validIds.has(entry.id) && (canAccessPremium || !premiumIds.has(entry.id))
  );

  if (filtered.length === current.length) return undefined;

  if (modality === 'text' && filtered.length === 0) {
    if (!textFallback) return undefined;
    return [textFallback];
  }
  return filtered;
}

const MODALITIES: readonly LegacyModality[] = ['text', 'image', 'audio', 'video'];

export function useModelValidation(): void {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: balanceData } = useBalance();
  const { data: modelsData } = useModels();
  const selections = useModelStore((state) => state.selections);
  const setSelectedModels = useModelStore((state) => state.setSelectedModels);
  const activeModality = useModelStore((state) => state.activeModality);
  const setActiveModality = useModelStore((state) => state.setActiveModality);

  // Trial users (unauthenticated) cannot access media modalities. Force them
  // into text when a persisted non-text modality survives a logout or arrives
  // from an earlier authenticated session in localStorage.
  React.useEffect(() => {
    if (isSessionPending) return;
    const isAuthenticated = Boolean(session?.user);
    if (!isAuthenticated && activeModality !== 'text') {
      setActiveModality('text');
    }
  }, [session?.user, isSessionPending, activeModality, setActiveModality]);

  React.useEffect(() => {
    const isAuthenticated = Boolean(session?.user);
    const state = getValidationState({
      modelsData,
      isSessionPending,
      isAuthenticated,
      balanceData,
    });

    if (!state.isReady || !modelsData) return;

    const { models, premiumIds } = modelsData;
    const { canAccessPremium } = state;

    const { strongestId } = getAccessibleModelIds(models, premiumIds, canAccessPremium);
    const strongestModel = models.find((m) => m.id === strongestId);
    // The strongest pin is only a usable text fallback when the user can
    // actually reach it; substituting an inaccessible (premium-for-this-tier)
    // model would re-trigger the filter on the next pass and loop forever. An
    // absent pin (no candidate/popularity signal) yields no fallback.
    const textFallback: SelectedModelEntry | undefined =
      strongestModel && (canAccessPremium || !premiumIds.has(strongestModel.id))
        ? { id: strongestModel.id, name: strongestModel.name }
        : undefined;

    for (const modality of MODALITIES) {
      const modalityModels = models.filter((m) => m.modality === modality);
      const next = validateModality({
        modality,
        current: selections[modality],
        models: modalityModels,
        premiumIds,
        canAccessPremium,
        textFallback,
      });
      if (next !== undefined) {
        setSelectedModels(modality, next);
      }
    }
  }, [modelsData, session?.user, isSessionPending, balanceData, selections, setSelectedModels]);
}
