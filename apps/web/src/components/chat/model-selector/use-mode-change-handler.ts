import * as React from 'react';
import { type PickerMode } from '@/stores/model';

import { buildSelectedEntries } from '@/components/chat/model-selector/model-selector-helpers';
import type { Model, LegacyModality } from '@hushbox/shared';

interface ModeChangeHandlerParams {
  setPickerMode: (modality: LegacyModality, mode: PickerMode) => void;
  resolvedModality: LegacyModality;
  localSelectedIds: Set<string>;
  setLocalSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  models: Model[];
  onSelect: (models: { id: string; name: string }[]) => void;
}

/**
 * Handles the picker mode toggle. On multi → single with >1 selected, auto-
 * collapses local + committed selection to the first model so the displayed
 * mode and committed state stay in sync.
 */
export function useModeChangeHandler({
  setPickerMode,
  resolvedModality,
  localSelectedIds,
  setLocalSelectedIds,
  models,
  onSelect,
}: ModeChangeHandlerParams): (next: PickerMode) => void {
  return React.useCallback(
    (next: PickerMode): void => {
      const shouldCollapse = next === 'single' && localSelectedIds.size > 1;
      if (shouldCollapse) {
        const firstId = localSelectedIds.values().next().value;
        if (firstId !== undefined) {
          const collapsed = new Set([firstId]);
          setLocalSelectedIds(collapsed);
          onSelect(buildSelectedEntries(collapsed, models));
        }
      }
      setPickerMode(resolvedModality, next);
    },
    [setPickerMode, resolvedModality, localSelectedIds, setLocalSelectedIds, models, onSelect]
  );
}
