import * as React from 'react';
import { useSession } from '@/lib/auth';
import { useModelStore } from '@/stores/model';
import { usePayerPremiumAccess } from '@/hooks/models/use-payer-premium-access.js';
import { useModels, getAccessibleModelIds } from '@/hooks/models/models.js';
import type { Model, ChatModality } from '@hushbox/shared';
import type { SelectedModelEntry } from '@/stores/model';

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

/**
 * Prunes persisted model selections the catalog no longer carries, and
 * substitutes the strongest reachable text model when that empties the text
 * selection.
 *
 * `conversationId` names the payer whose tier decides reachability: this hook
 * only CHOOSES a fallback and greys nothing, but choosing at the sender's tier
 * inside an owner-funded conversation contradicts the option sets the composer
 * renders for the same caller.
 */
export function useModelValidation(conversationId: string | null): void {
  const { data: session, isPending: isSessionPending } = useSession();
  const access = usePayerPremiumAccess(conversationId);
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
    if (access.isPending || !modelsData) return;

    const { models, premiumIds } = modelsData;
    const { canAccessPremium } = access;

    const { strongestId } = getAccessibleModelIds(models, premiumIds, canAccessPremium);
    const strongestModel = models.find((m) => m.id === strongestId);
    // The strongest pin is only a usable text fallback when the payer can
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
  }, [modelsData, access, selections, setSelectedModels]);
}
