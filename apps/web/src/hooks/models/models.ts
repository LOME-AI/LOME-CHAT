import { useQuery } from '@tanstack/react-query';
import { SMART_MODEL_ID } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';
import type { Model, ChatModality } from '@hushbox/shared';

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
      const response = await fetchJson(client.models.$get());
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

const NO_PINS = { strongestId: '', valueId: '' } as const;

/**
 * Text-only strongest/value quick-select pins, derived from popularity.
 *
 * The tier-selectable text models (paid = all text; trial/free = non-premium
 * text; the Smart Model is never a pin) are ranked by `popularityRank` and the
 * most-popular half is kept; within that half the priciest model is "Strongest"
 * and the cheapest is "Value" (price is fee-inclusive per 1k tokens). This keeps
 * a rarely-used but expensive model from being surfaced as the day-to-day pick.
 *
 * Media modalities (image/video/audio) get no pins. A candidate set that is
 * empty or entirely unranked yields no pins — with no popularity signal there is
 * no basis for a "top half" pick.
 */
export function getAccessibleModelIds(
  models: Model[],
  premiumIds: Set<string>,
  canAccessPremium: boolean,
  modality: ChatModality = 'text'
): { strongestId: string; valueId: string } {
  if (modality !== 'text') return { ...NO_PINS };

  const candidate = models.filter(
    (m) =>
      m.modality === 'text' &&
      m.id !== SMART_MODEL_ID &&
      (canAccessPremium || !premiumIds.has(m.id))
  );
  if (candidate.length === 0) return { ...NO_PINS };
  if (candidate.every((m) => m.popularityRank === undefined)) return { ...NO_PINS };

  const sorted = candidate.toSorted(
    (a, b) => (a.popularityRank ?? Infinity) - (b.popularityRank ?? Infinity)
  );
  const topHalf = sorted.slice(0, Math.ceil(sorted.length / 2));

  const first = topHalf[0];
  /* v8 ignore next -- candidate is non-empty (guarded), so topHalf always has ceil(n/2) >= 1 entries */
  if (first === undefined) return { ...NO_PINS };

  // Combined BASE (pre-markup) nano rate; the markup is monotonic, so the
  // strongest/value ranking is identical whether on base or customer price.
  const cost = (m: Model): bigint =>
    BigInt(m.pricing.inputPerToken ?? '0') + BigInt(m.pricing.outputPerToken ?? '0');
  let strongest = first;
  let value = first;
  for (const m of topHalf) {
    // Strict comparisons keep the first-encountered model on price ties.
    if (cost(m) > cost(strongest)) strongest = m;
    if (cost(m) < cost(value)) value = m;
  }

  return { strongestId: strongest.id, valueId: value.id };
}
