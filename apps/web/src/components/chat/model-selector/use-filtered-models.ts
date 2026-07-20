import * as React from 'react';

import {
  filterBySearch,
  sortModels,
  sortByPopularity,
  interlaceModels,
  buildModelResultList,
  type SortField,
  type SortDirection,
} from '@/components/chat/model-selector/model-selector-helpers';
import type { Model, ChatModality } from '@hushbox/shared';

interface UseFilteredModelsOptions {
  models: Model[];
  searchQuery: string;
  sortField: SortField;
  sortDirection: SortDirection;
  premiumIds: Set<string>;
  canAccessPremium: boolean;
  strongestId: string;
  valueId: string;
  /** Only show models matching this modality. Defaults to 'text'. */
  activeModality?: ChatModality | undefined;
}

export function useFilteredModels({
  models,
  searchQuery,
  sortField,
  sortDirection,
  premiumIds,
  canAccessPremium,
  strongestId,
  valueId,
  activeModality = 'text',
}: UseFilteredModelsOptions): Model[] {
  return React.useMemo(() => {
    const isDefault = sortField === null && !searchQuery.trim();

    // Filter to models matching the active modality. Smart Model is text-only.
    const modalityFiltered = models.filter((m) => m.modality === activeModality);
    const smartModel =
      activeModality === 'text' ? modalityFiltered.find((m) => m.isSmartModel === true) : undefined;
    const nonSmartModels = modalityFiltered.filter((m) => m.isSmartModel !== true);

    const result = filterBySearch(nonSmartModels, searchQuery);
    const ordered = isDefault
      ? sortByPopularity(result)
      : sortModels(result, sortField, sortDirection, activeModality);
    const interlaced = interlaceModels(ordered, premiumIds, canAccessPremium, isDefault);

    return buildModelResultList({ interlaced, smartModel, strongestId, valueId, isDefault });
  }, [
    models,
    searchQuery,
    sortField,
    sortDirection,
    premiumIds,
    canAccessPremium,
    strongestId,
    valueId,
    activeModality,
  ]);
}
