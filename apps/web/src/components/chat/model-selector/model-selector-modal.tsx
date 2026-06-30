import * as React from 'react';
import { AnimatePresence } from 'framer-motion';
import { Overlay, useIsMobile } from '@hushbox/ui';
import { useModelStore } from '@/stores/model';
import { getAccessibleModelIds } from '@/hooks/models/models';

import { SignupModal } from '@/components/auth/signup-modal';
import {
  resolveModality,
  getPinnedLabelForModel,
  toggleSortDirection,
  buildSelectedEntries,
  updateSelectedIds,
  initialFocusedId,
  type SortField,
  type SortDirection,
} from '@/components/chat/model-selector/model-selector-helpers';
import { useFilteredModels } from '@/components/chat/model-selector/use-filtered-models';
import { useModeChangeHandler } from '@/components/chat/model-selector/use-mode-change-handler';
import { useCarryoverPulse } from '@/components/chat/media/use-carryover-pulse';
import {
  ModelSelectorFooter,
  MultiCountChip,
} from '@/components/chat/model-selector/model-selector-footer';
import { ModelSelectorModalLayout } from '@/components/chat/model-selector/model-selector-layout';
import type { SearchAndSortSectionProps } from '@/components/chat/model-selector/search-and-sort-section';
import type { ModelSelectorGatingProps } from '@/components/chat/model-selector/model-selector-types';
import type { Model, LegacyModality } from '@hushbox/shared';

interface ModelSelectorModalProps extends ModelSelectorGatingProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: Model[];
  selectedIds: Set<string>;
  onSelect: (models: { id: string; name: string }[]) => void;
  /** Filter models to match this modality. Defaults to 'text' for back-compat. */
  activeModality?: LegacyModality;
}

/**
 * Model selector modal with search, sort, premium gating, and per-modality
 * scoping. Single mode commits + closes on row click. Multi mode toggles a
 * local pending selection committed via the footer.
 */
export function ModelSelectorModal({
  open,
  onOpenChange,
  models,
  selectedIds,
  onSelect,
  premiumIds,
  canAccessPremium = true,
  isAuthenticated = true,
  isLinkGuest,
  onPremiumClick,
  activeModality,
}: Readonly<ModelSelectorModalProps>): React.JSX.Element {
  const isMobile = useIsMobile();
  const resolvedModality = resolveModality(activeModality);
  const pickerMode = useModelStore((s) => s.pickerMode[resolvedModality]);
  const setPickerMode = useModelStore((s) => s.setPickerMode);

  const [searchQuery, setSearchQuery] = React.useState('');
  const [focusedModelId, setFocusedModelId] = React.useState(initialFocusedId(selectedIds, models));
  const [sortField, setSortField] = React.useState<SortField>(null);
  const [sortDirection, setSortDirection] = React.useState<SortDirection>('asc');
  const [localSelectedIds, setLocalSelectedIds] = React.useState<Set<string>>(new Set(selectedIds));
  const [expandedModelId, setExpandedModelId] = React.useState<string | null>(null);
  const [showMultiModelSignup, setShowMultiModelSignup] = React.useState(false);
  const pulsingModelId = useCarryoverPulse(pickerMode, selectedIds, open);

  React.useEffect(() => {
    if (!open) return;
    setShowMultiModelSignup(false);
    setLocalSelectedIds(new Set(selectedIds));
    setFocusedModelId(initialFocusedId(selectedIds, models));
    setSearchQuery('');
    setExpandedModelId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- models is a fallback; re-running on models change would reset user's selection
  }, [open, selectedIds]);

  // Calculate quick select model IDs based on user tier and active modality.
  // Without `activeModality`, the helper defaults to 'text' and returns text-
  // model IDs that don't match the modality-filtered list, so Strongest/Value
  // pins disappear in image/video mode.
  const { strongestId, valueId } = React.useMemo(
    () => getAccessibleModelIds(models, premiumIds ?? new Set(), canAccessPremium, activeModality),
    [models, premiumIds, canAccessPremium, activeModality]
  );

  const filteredModels = useFilteredModels({
    models,
    searchQuery,
    sortField,
    sortDirection,
    premiumIds: premiumIds ?? new Set(),
    canAccessPremium,
    strongestId,
    valueId,
    activeModality,
  });

  const handleSortClick = React.useCallback(
    (field: 'price' | 'context'): void => {
      if (sortField === field) {
        setSortDirection(toggleSortDirection);
      } else {
        setSortField(field);
        setSortDirection('asc');
      }
    },
    [sortField]
  );

  const getPinnedLabel = React.useCallback(
    (modelId: string): string | undefined => getPinnedLabelForModel(modelId, strongestId, valueId),
    [strongestId, valueId]
  );

  const focusedModel = models.find((m) => m.id === focusedModelId) ?? models[0];

  const isPremium = React.useCallback(
    (modelId: string): boolean => premiumIds?.has(modelId) ?? false,
    [premiumIds]
  );

  const handleHoverModel = React.useCallback((modelId: string): void => {
    setFocusedModelId(modelId);
  }, []);

  const handleShowInfo = React.useCallback((modelId: string): void => {
    setFocusedModelId(modelId);
  }, []);

  const handleToggleExpand = React.useCallback((modelId: string): void => {
    setExpandedModelId((current) => (current === modelId ? null : modelId));
  }, []);

  const commitSingleSelection = React.useCallback(
    (model: Model): void => {
      onSelect([{ id: model.id, name: model.name }]);
      onOpenChange(false);
    },
    [onSelect, onOpenChange]
  );

  const isPremiumGated = React.useCallback(
    (modelId: string): boolean =>
      !isLinkGuest && !canAccessPremium && (premiumIds?.has(modelId) ?? false),
    [isLinkGuest, canAccessPremium, premiumIds]
  );

  const isMultiModelSignupBlocked = React.useCallback(
    (modelId: string): boolean =>
      !isLinkGuest &&
      !isAuthenticated &&
      !localSelectedIds.has(modelId) &&
      localSelectedIds.size > 0,
    [isLinkGuest, isAuthenticated, localSelectedIds]
  );

  /**
   * Mode-aware row activation. Single mode commits the picked model and closes
   * the modal; multi mode toggles the model in the local pending selection.
   * Premium gates fire before either path so unentitled users always hit the
   * paywall regardless of mode.
   */
  const handleRowActivate = React.useCallback(
    (modelId: string): void => {
      const model = models.find((m) => m.id === modelId);
      if (!model) return;

      if (isPremiumGated(modelId)) {
        onPremiumClick?.(modelId);
        return;
      }

      if (pickerMode === 'single') {
        commitSingleSelection(model);
        return;
      }

      if (isMultiModelSignupBlocked(modelId)) {
        setShowMultiModelSignup(true);
        return;
      }

      setFocusedModelId(modelId);
      setLocalSelectedIds((previous) => updateSelectedIds(previous, modelId));
    },
    [
      models,
      isPremiumGated,
      onPremiumClick,
      pickerMode,
      isMultiModelSignupBlocked,
      commitSingleSelection,
    ]
  );

  const handleConfirmSelection = React.useCallback((): void => {
    onSelect(buildSelectedEntries(localSelectedIds, models));
    onOpenChange(false);
  }, [localSelectedIds, models, onSelect, onOpenChange]);

  const handleClearSelection = React.useCallback((): void => {
    setLocalSelectedIds(new Set());
  }, []);

  const handleCancel = React.useCallback((): void => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleModeChange = useModeChangeHandler({
    setPickerMode,
    resolvedModality,
    localSelectedIds,
    setLocalSelectedIds,
    models,
    onSelect,
  });

  // Prevent auto-focus on mobile to avoid triggering keyboard
  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      if (isMobile) {
        event.preventDefault();
      }
    },
    [isMobile]
  );

  const showFooter = pickerMode === 'multi';
  const multiSelectionCount = localSelectedIds.size;
  const multiLabel = <span>Multiple models at once</span>;

  const searchAndSortProps: SearchAndSortSectionProps = {
    searchQuery,
    onSearchChange: setSearchQuery,
    sortField,
    sortDirection,
    onSortClick: handleSortClick,
    activeModality: resolvedModality,
    rightAccessory: (
      <AnimatePresence initial={false}>
        {pickerMode === 'multi' && (
          <MultiCountChip
            key="multi-count-chip"
            selectedCount={multiSelectionCount}
            onClear={handleClearSelection}
          />
        )}
      </AnimatePresence>
    ),
  };

  return (
    <>
      <Overlay
        open={open}
        onOpenChange={onOpenChange}
        ariaLabel="Select model"
        onOpenAutoFocus={handleOpenAutoFocus}
      >
        <ModelSelectorModalLayout
          isMobile={isMobile}
          pickerMode={pickerMode}
          multiLabel={multiLabel}
          searchAndSortProps={searchAndSortProps}
          handleModeChange={handleModeChange}
          focusedModel={focusedModel}
          modelListBodyProps={{
            filteredModels,
            pickerMode,
            selectedIds,
            localSelectedIds,
            focusedModelId,
            expandedModelId,
            isPremium,
            canAccessPremium,
            isAuthenticated,
            isLinkGuest: isLinkGuest ?? false,
            isMobile,
            pulsingModelId,
            getPinnedLabel,
            onActivate: handleRowActivate,
            onHover: handleHoverModel,
            onShowInfo: handleShowInfo,
            onToggleExpand: handleToggleExpand,
          }}
          footer={
            <AnimatePresence initial={false}>
              {showFooter && (
                <ModelSelectorFooter
                  key="model-selector-footer"
                  selectedCount={multiSelectionCount}
                  onCancel={handleCancel}
                  onConfirm={handleConfirmSelection}
                />
              )}
            </AnimatePresence>
          }
        />
      </Overlay>
      <SignupModal
        variant="multi-model"
        open={showMultiModelSignup}
        onOpenChange={setShowMultiModelSignup}
      />
    </>
  );
}
