import * as React from 'react';
import { MAX_SELECTED_MODELS } from '@hushbox/shared';
import { type PickerMode } from '@/stores/model';

import { ModelListItem } from '@/components/chat/model-selector/model-list-item';
import type { Model } from '@hushbox/shared';

export interface ModelListBodyProps {
  filteredModels: Model[];
  pickerMode: PickerMode;
  selectedIds: Set<string>;
  localSelectedIds: Set<string>;
  focusedModelId: string;
  expandedModelId: string | null;
  isPremium: (modelId: string) => boolean;
  /** Shared affordability-floor verdict — a true row greys, not selectable. */
  isBelowFloor: (model: Model) => boolean;
  canAccessPremium: boolean;
  isAuthenticated: boolean;
  isLinkGuest: boolean;
  isMobile: boolean;
  pulsingModelId: string | null;
  getPinnedLabel: (modelId: string) => string | undefined;
  onActivate: (modelId: string) => void;
  onHover: (modelId: string) => void;
  onShowInfo: (modelId: string) => void;
  onToggleExpand: (modelId: string) => void;
}

export function ModelListBody(props: Readonly<ModelListBodyProps>): React.JSX.Element {
  const {
    filteredModels,
    pickerMode,
    selectedIds,
    localSelectedIds,
    focusedModelId,
    expandedModelId,
    isPremium,
    isBelowFloor,
    canAccessPremium,
    isAuthenticated,
    isLinkGuest,
    isMobile,
    pulsingModelId,
    getPinnedLabel,
    onActivate,
    onHover,
    onShowInfo,
    onToggleExpand,
  } = props;
  const isAtLimit = pickerMode === 'multi' && localSelectedIds.size >= MAX_SELECTED_MODELS;

  return (
    <div
      className="overflow-hidden p-2 pr-3"
      role="listbox"
      aria-label="Models"
      aria-multiselectable={pickerMode === 'multi'}
    >
      {filteredModels.map((model, cascadeIndex) => {
        const isSelected =
          pickerMode === 'multi' ? localSelectedIds.has(model.id) : selectedIds.has(model.id);
        return (
          <ModelListItem
            key={model.id}
            model={model}
            isFocused={model.id === focusedModelId}
            isSelected={isSelected}
            isDisabled={isAtLimit && !localSelectedIds.has(model.id)}
            isPremium={isPremium(model.id)}
            isBelowFloor={isBelowFloor(model)}
            canAccessPremium={canAccessPremium}
            isAuthenticated={isAuthenticated}
            isLinkGuest={isLinkGuest}
            pickerMode={pickerMode}
            pinnedLabel={getPinnedLabel(model.id)}
            isExpanded={expandedModelId === model.id}
            isMobile={isMobile}
            isPulsing={model.id === pulsingModelId}
            cascadeIndex={cascadeIndex}
            onActivate={() => {
              onActivate(model.id);
            }}
            onHover={() => {
              onHover(model.id);
            }}
            onShowInfo={() => {
              onShowInfo(model.id);
            }}
            onToggleExpand={() => {
              onToggleExpand(model.id);
            }}
          />
        );
      })}
      {filteredModels.length === 0 && (
        <div className="text-muted-foreground p-4 text-center text-sm">No models found</div>
      )}
    </div>
  );
}
