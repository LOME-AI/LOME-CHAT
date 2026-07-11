import { useQuery } from '@tanstack/react-query';
import {
  STRONGEST_TEXT_MODEL_ID,
  VALUE_TEXT_MODEL_ID,
  STRONGEST_IMAGE_MODEL_ID,
  VALUE_IMAGE_MODEL_ID,
  STRONGEST_VIDEO_MODEL_ID,
  VALUE_VIDEO_MODEL_ID,
  SMART_MODEL_ID,
  getModelCostPer1k,
} from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';
import type { Model, ModelsListResponse, LegacyModality } from '@hushbox/shared';

export interface ModelsData {
  models: Model[];
  premiumIds: Set<string>;
}

export const modelKeys = {
  all: ['models'] as const,
  list: () => [...modelKeys.all, 'list'] as const,
  detail: (id: string) => [...modelKeys.all, id] as const,
};

/** Reusable query options for models list. Shared by hooks and route loaders. */
export function modelsQueryOptions(): {
  queryKey: readonly ['models', 'list'];
  queryFn: () => Promise<ModelsData>;
  staleTime: number;
} {
  return {
    queryKey: modelKeys.list(),
    queryFn: async (): Promise<ModelsData> => {
      const response = await fetchJson<ModelsListResponse>(client.models.$get());
      return {
        models: response.models,
        premiumIds: new Set(response.premiumModelIds),
      };
    },
    staleTime: 1000 * 60 * 60,
  };
}

export function useModels(): ReturnType<typeof useQuery<ModelsData, Error>> {
  return useQuery(modelsQueryOptions());
}

/**
 * Find the strongest (most expensive non-premium) and value (cheapest)
 * text models. Paid users still get non-premium ids — the goal is to
 * surface the user's typical day-to-day pick, not their most expensive
 * possible call.
 *
 * `withFallback` controls behavior when no basic text models are available:
 * - `true` (non-premium users): fall back to the first text model so the
 *   pins always resolve to *something* the user can chat with.
 * - `false` (paid users): return null so the caller can drop in hard-coded
 *   premium constants instead.
 */
function findStrongestAndValueTextModels(
  models: Model[],
  premiumIds: Set<string>,
  withFallback: boolean
): { strongestId: string; valueId: string } | null {
  const basicTextModels = models.filter(
    (m) => m.modality === 'text' && m.id !== SMART_MODEL_ID && !premiumIds.has(m.id)
  );
  if (basicTextModels.length === 0) {
    if (!withFallback) return null;
    const fallback = models.find((m) => m.modality === 'text')?.id ?? '';
    return { strongestId: fallback, valueId: fallback };
  }

  const sorted = [...basicTextModels].toSorted((a, b) => {
    const priceA = getModelCostPer1k(a.pricePerInputToken, a.pricePerOutputToken);
    const priceB = getModelCostPer1k(b.pricePerInputToken, b.pricePerOutputToken);
    return priceB - priceA;
  });

  return {
    strongestId: sorted[0]?.id ?? '',
    valueId: sorted.at(-1)?.id ?? '',
  };
}

const PREMIUM_PINS: Record<LegacyModality, { strongestId: string; valueId: string }> = {
  text: { strongestId: STRONGEST_TEXT_MODEL_ID, valueId: VALUE_TEXT_MODEL_ID },
  image: { strongestId: STRONGEST_IMAGE_MODEL_ID, valueId: VALUE_IMAGE_MODEL_ID },
  video: { strongestId: STRONGEST_VIDEO_MODEL_ID, valueId: VALUE_VIDEO_MODEL_ID },
  audio: { strongestId: '', valueId: '' },
};

/**
 * Per-modality strongest/value quick-select pins.
 *
 * Plan §10.12: paid users on text resolve dynamically from the model list
 * (most expensive non-premium = strongest, cheapest = value), falling back
 * to the hard-coded constants only when the model list is empty.
 *
 * Image and video paid pins remain hard-coded — those modalities don't have
 * the same per-message price spread that makes a dynamic pick meaningful.
 *
 * Non-premium users can't access media modalities at all (all media models
 * are classified as premium in `processModels`); the text fallback derives
 * strongest/value from the user's accessible basic-tier text models.
 */
export function getAccessibleModelIds(
  models: Model[],
  premiumIds: Set<string>,
  canAccessPremium: boolean,
  modality: LegacyModality = 'text'
): { strongestId: string; valueId: string } {
  if (canAccessPremium) {
    if (modality === 'text') {
      return findStrongestAndValueTextModels(models, premiumIds, false) ?? PREMIUM_PINS.text;
    }
    return PREMIUM_PINS[modality];
  }
  if (modality === 'text') {
    // With `withFallback: true` the function always returns a result (never null).
    return (
      findStrongestAndValueTextModels(models, premiumIds, true) ?? { strongestId: '', valueId: '' }
    );
  }
  return { strongestId: '', valueId: '' };
}
