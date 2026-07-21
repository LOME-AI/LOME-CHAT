import { MAX_SELECTED_MODELS, nanoUnitPriceUsd, shortenModelName } from '@hushbox/shared';
import { formatContextLength } from '@/lib/format';

import type { PickerMode } from '@/stores/model';
import type { Model, ChatModality } from '@hushbox/shared';

export type SortField = 'price' | 'context' | null;
export type SortDirection = 'asc' | 'desc';

/** Smallest of a list of nano-USD rates; 0n for an empty list. */
function minNano([first = 0n, ...rest]: readonly bigint[]): bigint {
  // `Math.min` can't take bigint, so fold with a plain loop.
  let lowest = first;
  for (const value of rest) {
    if (value < lowest) lowest = value;
  }
  return lowest;
}

export function filterBySearch(models: Model[], query: string): Model[] {
  if (!query.trim()) {
    return models;
  }
  const lowerQuery = query.toLowerCase();
  return models.filter(
    (model) =>
      model.name.toLowerCase().includes(lowerQuery) ||
      model.provider.toLowerCase().includes(lowerQuery)
  );
}

export function resolveModality(activeModality: ChatModality | undefined): ChatModality {
  return activeModality ?? 'text';
}

// BASE (pre-markup) nano rate as the sort key. The 15% markup is monotonic, so
// sorting on the base rate yields the same order as the customer-facing price;
// no markup or display conversion is needed to order the list.
function priceSortKey(model: Model, modality: ChatModality): bigint {
  switch (modality) {
    case 'text': {
      return BigInt(model.pricing.inputPerToken ?? '0');
    }
    case 'image': {
      return BigInt(model.pricing.perImage ?? '0');
    }
    case 'video': {
      const values = Object.values(model.pricing.perSecondByResolution ?? {}).map(BigInt);
      return values.length > 0 ? minNano(values) : 0n;
    }
    case 'audio': {
      return 0n;
    }
  }
}

function compareBigint(a: bigint, b: bigint): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function sortModels(
  models: Model[],
  sortField: SortField,
  sortDirection: SortDirection,
  activeModality: ChatModality
): Model[] {
  if (!sortField) {
    return models;
  }
  return [...models].toSorted((a, b) => {
    const comparison =
      sortField === 'price'
        ? compareBigint(priceSortKey(a, activeModality), priceSortKey(b, activeModality))
        : a.contextLength - b.contextLength;
    return sortDirection === 'asc' ? comparison : -comparison;
  });
}

// Default-view ordering: most-used models first. `popularityRank` is 0-based
// (lower = more used); unranked models (undefined, e.g. media) sort last.
// `toSorted` is stable, so equal or both-undefined ranks keep input order.
export function sortByPopularity(models: Model[]): Model[] {
  const rankOf = (model: Model): number => model.popularityRank ?? Infinity;
  return models.toSorted((a, b) => rankOf(a) - rankOf(b));
}

// Trial default view: surface the available-only models (the basics that have no
// premium to pair with) above the interleaved available/unavailable pairs, so a trial
// user sees what they can use first rather than trailing at the bottom of the list.
function zipAvailableFirst(basic: Model[], premium: Model[]): Model[] {
  const leftoverAvailable = basic.slice(premium.length);
  const pairs: Model[] = [];
  for (const [index, premiumModel] of premium.entries()) {
    const basicModel = basic[index];
    if (basicModel) pairs.push(basicModel);
    pairs.push(premiumModel);
  }
  return [...leftoverAvailable, ...pairs];
}

export function interlaceModels(
  models: Model[],
  premiumIds: Set<string>,
  canAccessPremium: boolean,
  surfaceAvailableFirst = false
): Model[] {
  if (canAccessPremium || premiumIds.size === 0) {
    return models;
  }
  const basic = models.filter((m) => !premiumIds.has(m.id));
  const premium = models.filter((m) => premiumIds.has(m.id));

  if (surfaceAvailableFirst) {
    return zipAvailableFirst(basic, premium);
  }

  const interlaced: Model[] = [];
  const maxLength = Math.max(basic.length, premium.length);
  for (let index = 0; index < maxLength; index++) {
    const basicModel = basic[index];
    const premiumModel = premium[index];
    if (basicModel) interlaced.push(basicModel);
    if (premiumModel) interlaced.push(premiumModel);
  }
  return interlaced;
}

export function modelSubtitle(model: Model): string {
  if (model.isSmartModel === true) {
    return 'Auto-picks the best model';
  }
  switch (model.modality) {
    case 'text': {
      return `${model.provider} • Capacity: ${formatContextLength(model.contextLength)}`;
    }
    case 'image': {
      return `${model.provider} • ${nanoUnitPriceUsd(BigInt(model.pricing.perImage ?? '0'), 3)}/image`;
    }
    case 'video': {
      const values = Object.values(model.pricing.perSecondByResolution ?? {}).map(BigInt);
      if (values.length === 0) {
        return model.provider;
      }
      return `${model.provider} • ${nanoUnitPriceUsd(minNano(values), 2)}/s`;
    }
    case 'audio': {
      // Audio carries no wire pricing dimension; show the provider only.
      return model.provider;
    }
  }
}

export function expandedRowButtonLabel(
  pickerMode: PickerMode,
  isSelected: boolean,
  modelName: string
): string {
  if (pickerMode === 'single') return `Use ${shortenModelName(modelName)}`;
  if (isSelected) return 'Remove from selection';
  return 'Add to selection';
}

/**
 * Assembles the final model list: Smart Model first (when present), then
 * pinned quick-select models (in default view only), then the remaining
 * interlaced list. Keeps `useFilteredModels` focused on filtering/sorting.
 */
export function buildModelResultList(params: {
  interlaced: Model[];
  smartModel: Model | undefined;
  strongestId: string;
  valueId: string;
  isDefault: boolean;
}): Model[] {
  const { interlaced, smartModel, strongestId, valueId, isDefault } = params;
  const smartPrefix = smartModel ? [smartModel] : [];
  if (!isDefault) {
    return [...smartPrefix, ...interlaced];
  }
  const pinnedIds = [...new Set([strongestId, valueId])];
  const pinned = pinnedIds
    .map((id) => interlaced.find((m) => m.id === id))
    .filter((m): m is Model => m !== undefined);
  const remaining = interlaced.filter((m) => !pinnedIds.includes(m.id));
  return [...smartPrefix, ...pinned, ...remaining];
}

export function getPinnedLabelForModel(
  modelId: string,
  strongestId: string,
  valueId: string
): string | undefined {
  if (modelId === strongestId) return 'Strongest';
  if (modelId === valueId) return 'Best value';
  return undefined;
}

export function toggleSortDirection(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc';
}

export function buildSelectedEntries(
  selectedIds: Set<string>,
  models: Model[]
): { id: string; name: string }[] {
  return [...selectedIds]
    .map((id) => {
      const model = models.find((m) => m.id === id);
      return model ? { id: model.id, name: model.name } : null;
    })
    .filter((entry): entry is { id: string; name: string } => entry !== null);
}

export function updateSelectedIds(previous: Set<string>, modelId: string): Set<string> {
  const next = new Set(previous);
  if (next.has(modelId)) {
    next.delete(modelId);
  } else {
    if (next.size >= MAX_SELECTED_MODELS) return previous;
    next.add(modelId);
  }
  return next;
}

export function initialFocusedId(selectedIds: Set<string>, models: Model[]): string {
  const firstSelected = selectedIds.values().next().value;
  if (firstSelected !== undefined) return firstSelected;
  return models[0]?.id ?? '';
}
