import * as React from 'react';
import { Button } from '@hushbox/ui';
import { shortenModelName, TEST_IDS } from '@hushbox/shared';
import { DEFAULT_MODEL_NAME } from '@/stores/model';
import { ModelSelectorModal } from '@/components/chat/model-selector/model-selector-modal';
import type { Model, ChatModality } from '@hushbox/shared';
import type { ModelFloorGroupContext } from '@/hooks/billing/use-prompt-budget';
import type { ModelSelectorGatingProps } from '@/components/chat/model-selector/model-selector-types';

function getModelDisplayText(
  selectedModels: { id: string; name: string }[],
  selectedModel: Model | undefined,
  firstEntry: { id: string; name: string } | undefined
): string {
  if (selectedModels.length > 1) {
    return `${String(selectedModels.length)} models`;
  }
  const rawName = selectedModel?.name ?? firstEntry?.name ?? DEFAULT_MODEL_NAME;
  return shortenModelName(rawName);
}

export interface ModelSelectorButtonProps extends ModelSelectorGatingProps {
  models: Model[];
  selectedModels: { id: string; name: string }[];
  onSelect: (models: { id: string; name: string }[]) => void;
  disabled?: boolean | undefined;
  activeModality?: ChatModality;
  /** Controlled open state. When provided with `onOpenChange`, drives the modal externally. */
  open?: boolean | undefined;
  /** Called when the modal wants to open or close. Required for controlled mode. */
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Group funding context for the modal's affordability floor (threading only). */
  floorGroup?: ModelFloorGroupContext | undefined;
}

/**
 * Button that opens the model selector modal.
 * Displays the selected model name, or "N models" when 2+ are selected.
 *
 * Supports both uncontrolled (internal state) and controlled (`open`/`onOpenChange`)
 * modes — controlled mode lets sibling components (e.g. ComparisonBar's +Add chip)
 * trigger the picker.
 */
function usePickerOpenState(
  controlledOpen: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined
): readonly [boolean, (open: boolean) => void] {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined && onOpenChange !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const setIsOpen = isControlled ? onOpenChange : setUncontrolledOpen;
  return [isOpen, setIsOpen] as const;
}

export function ModelSelectorButton({
  models,
  selectedModels,
  onSelect,
  disabled = false,
  premiumIds,
  canAccessPremium = true,
  isAuthenticated = true,
  isLinkGuest = false,
  onPremiumClick,
  activeModality = 'text',
  open: controlledOpen,
  onOpenChange,
  floorGroup,
}: Readonly<ModelSelectorButtonProps>): React.JSX.Element {
  const [isOpen, setIsOpen] = usePickerOpenState(controlledOpen, onOpenChange);

  const firstEntry = selectedModels[0];
  const selectedId = firstEntry?.id ?? '';
  const selectedModel = models.find((m) => m.id === selectedId);
  const displayText = getModelDisplayText(selectedModels, selectedModel, firstEntry);

  const selectedIds = React.useMemo(
    () => new Set(selectedModels.map((m) => m.id)),
    [selectedModels]
  );

  const handleClick = (): void => {
    if (!disabled) {
      setIsOpen(true);
    }
  };

  return (
    <>
      <Button
        id="model-selector-button"
        variant="outline"
        onClick={handleClick}
        disabled={disabled}
        aria-label={`Select model (current: ${displayText})`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        data-testid={TEST_IDS.modelSelectorButton}
        className="bg-secondary hover:bg-secondary/80 mx-2 justify-center px-6"
      >
        <span>{displayText}</span>
      </Button>

      <ModelSelectorModal
        open={isOpen}
        onOpenChange={setIsOpen}
        models={models}
        selectedIds={selectedIds}
        onSelect={onSelect}
        premiumIds={premiumIds}
        canAccessPremium={canAccessPremium}
        isAuthenticated={isAuthenticated}
        isLinkGuest={isLinkGuest}
        onPremiumClick={onPremiumClick}
        activeModality={activeModality}
        floorGroup={floorGroup}
      />
    </>
  );
}
