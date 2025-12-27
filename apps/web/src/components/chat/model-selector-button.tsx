import * as React from 'react';
import { Button } from '@lome-chat/ui';
import type { Model } from '@lome-chat/shared';
import { ModelSelectorModal } from './model-selector-modal';

interface ModelSelectorButtonProps {
  models: Model[];
  selectedId: string;
  onSelect: (modelId: string) => void;
  disabled?: boolean;
}

/**
 * Button that opens the model selector modal.
 * Displays the selected model name.
 */
export function ModelSelectorButton({
  models,
  selectedId,
  onSelect,
  disabled = false,
}: ModelSelectorButtonProps): React.JSX.Element {
  const [isOpen, setIsOpen] = React.useState(false);

  const selectedModel = models.find((m) => m.id === selectedId);
  const displayText = selectedModel?.name ?? 'Select model';

  const handleClick = (): void => {
    if (!disabled) {
      setIsOpen(true);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={handleClick}
        disabled={disabled}
        aria-label="Select model"
        data-testid="model-selector-button"
        className="bg-secondary hover:bg-secondary/80 w-[250px] justify-center"
      >
        <span className="truncate">{displayText}</span>
      </Button>

      <ModelSelectorModal
        open={isOpen}
        onOpenChange={setIsOpen}
        models={models}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </>
  );
}
