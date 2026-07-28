import * as React from 'react';
import { AnimatePresence } from 'framer-motion';
import { Overlay, useIsMobile } from '@hushbox/ui';
import { EMPTY_PROMPT_BASIS, type Availability } from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { getAccessibleModelIds } from '@/hooks/models/models';
import { useTurnOptions } from '@/hooks/billing/use-turn-options';

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
import type { Model, ChatModality } from '@hushbox/shared';

interface ModelSelectorModalProps extends ModelSelectorGatingProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: Model[];
  selectedIds: Set<string>;
  onSelect: (models: { id: string; name: string }[]) => void;
  /** Filter models to match this modality. Defaults to 'text' for back-compat. */
  activeModality?: ChatModality;
  /**
   * The conversation the picker was opened from — it NAMES THE PAYER, so
   * without it the verdict is self-funded only, which would grey models a
   * group member's delegated budget funds.
   */
  floorGroup?: { readonly conversationId: string } | undefined;
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
  isAuthenticated = true,
  isLinkGuest,
  onPremiumClick,
  activeModality,
  floorGroup,
}: Readonly<ModelSelectorModalProps>): React.JSX.Element {
  const isMobile = useIsMobile();
  // ONE verdict: the picker greys from `affordable`, the set the composer's
  // send gate is the hold-aware twin of (BILLING §Affordability, the four
  // notions). The picker asks the prompt-INDEPENDENT question — "can this payer
  // call this model at all" — so it passes the empty basis; the producer
  // evaluates `affordable` against an empty basis regardless, which is what
  // keeps rows from churning while the user types.
  const turnOptions = useTurnOptions({
    basis: EMPTY_PROMPT_BASIS,
    isAuthenticated,
    ...(floorGroup === undefined ? {} : { conversationId: floorGroup.conversationId }),
  });

  /**
   * A row's verdict. While the funding or catalog read is in flight the
   * producer has no verdict to give, and a row must render NEUTRAL rather than
   * refused — treating a pending read as a refusal is what greyed every
   * affordable row for a render.
   */
  /**
   * Whether this payer can reach premium models at all, READ OFF the produced
   * set rather than computed: a premium row the producer marked unavailable is
   * exactly a model this payer cannot reach. It orders the list (reachable
   * models first) and gates nothing — the verdict is already on every row.
   */
  const canAccessPremium = !(turnOptions.options?.affordable.all ?? []).some(
    (row) =>
      !row.availability.available &&
      (row.availability.reason === 'premium_requires_credit' ||
        row.availability.reason === 'premium_requires_account')
  );

  const availabilityOf = React.useCallback(
    (modelId: string): Availability => {
      const entry = turnOptions.options?.affordable.all.find((row) => row.modelId === modelId);
      return entry?.availability ?? { available: true };
    },
    [turnOptions.options]
  );
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

      // Removing a selection is ALWAYS allowed, checked before any refusal: a
      // model that becomes unavailable after it was selected would otherwise be
      // escapable only via Clear-all, trapping the whole selection behind the
      // one row the user wants to drop.
      const isRemoval = pickerMode === 'multi' && localSelectedIds.has(modelId);
      if (!isRemoval) {
        const availability = availabilityOf(modelId);
        if (!availability.available) {
          // A premium lock routes to the paywall — the one reason whose action
          // the user can take from here. Every other reason simply refuses.
          const isPremiumLock =
            availability.reason === 'premium_requires_credit' ||
            availability.reason === 'premium_requires_account';
          if (isPremiumLock) onPremiumClick?.(modelId);
          return;
        }
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
      onPremiumClick,
      availabilityOf,
      pickerMode,
      localSelectedIds,
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
            availabilityOf,
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
