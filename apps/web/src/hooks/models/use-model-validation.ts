import * as React from 'react';
import { tierCanAccessPremium } from '@hushbox/shared';
import { useSession } from '@/lib/auth';
import { useModelStore } from '@/stores/model';
import { useSpendable } from '@/hooks/billing/use-spendable.js';
import { useModels, getAccessibleModelIds } from '@/hooks/models/models.js';
import type { Model, ChatModality, UserTier } from '@hushbox/shared';
import type { SelectedModelEntry } from '@/stores/model';
import type { ModelsData } from '@/hooks/models/models.js';

interface ValidationStateParams {
  modelsData: ModelsData | undefined;
  isSessionPending: boolean;
  isAuthenticated: boolean;
  /** The PAYER's served tier (`GET /billing/spendable`); absent while it loads. */
  servedTier: UserTier | undefined;
}

type ValidationState = { isReady: false } | { isReady: true; canAccessPremium: boolean };

/**
 * Premium access from the SERVED tier, never from a balance: the balance
 * endpoint is not an affordability input (BILLING §Affordability 4), and the
 * tier that decides premium is the payer's, which the funding snapshot names.
 * This hook only CHOOSES a fallback — it greys nothing — but choosing from a
 * second derivation of the same fact is how the two drift.
 */
function getValidationState(params: ValidationStateParams): ValidationState {
  const { modelsData, isSessionPending, isAuthenticated, servedTier } = params;

  if (!modelsData) return { isReady: false };
  if (isSessionPending) return { isReady: false };
  if (isAuthenticated && servedTier === undefined) return { isReady: false };

  // Unauthenticated payers have no endpoint by design; no tier reaches premium
  // except paid, so their answer is the same either way.
  const canAccessPremium = servedTier !== undefined && tierCanAccessPremium(servedTier);

  return { isReady: true, canAccessPremium };
}

interface ValidateModalityParams {
  modality: ChatModality;
  current: SelectedModelEntry[];
  models: Model[];
  textFallback: SelectedModelEntry | undefined;
}

/**
 * Returns the next selection list for a modality, or `undefined` if no change is needed.
 *
 * Drops ONLY entries the catalog no longer carries. A premium model the payer
 * cannot currently reach is deliberately KEPT: it renders marked with its
 * reason, and removing it from the store is the "hide what you cannot afford"
 * shape the product rule forbids (BILLING §Data Structures — options are marked,
 * never filtered). It also silently rewrote a user's selection on a balance
 * change, which is a selection the user never made.
 */
function validateModality(params: ValidateModalityParams): SelectedModelEntry[] | undefined {
  const { modality, current, models, textFallback } = params;
  // Empty text is impossible at runtime (subscriber guard + merge restore it);
  // empty image/audio/video is legitimate and is repopulated by useResolveDefaultModel.
  if (current.length === 0) return undefined;

  const validIds = new Set(models.map((m) => m.id));
  const filtered = current.filter((entry) => validIds.has(entry.id));

  if (filtered.length === current.length) return undefined;

  if (modality === 'text' && filtered.length === 0) {
    if (!textFallback) return undefined;
    return [textFallback];
  }
  return filtered;
}

const MODALITIES: readonly ChatModality[] = ['text', 'image', 'audio', 'video'];

export function useModelValidation(): void {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: spendableData } = useSpendable(null);
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
      servedTier: spendableData?.tier,
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
        textFallback,
      });
      if (next !== undefined) {
        setSelectedModels(modality, next);
      }
    }
  }, [modelsData, session?.user, isSessionPending, spendableData, selections, setSelectedModels]);
}
