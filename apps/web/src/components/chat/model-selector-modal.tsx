import * as React from 'react';
import { Search, ChevronUp, ChevronDown } from 'lucide-react';
import { ModalOverlay, Input, Badge, Button, ScrollArea } from '@lome-chat/ui';
import type { Model } from '@lome-chat/shared';
import { STRONGEST_MODEL_ID, VALUE_MODEL_ID } from '@lome-chat/shared';
import { formatContextLength, formatPricePer1k } from '../../lib/format';

type SortField = 'price' | 'context' | null;
type SortDirection = 'asc' | 'desc';

interface ModelSelectorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: Model[];
  selectedId: string;
  onSelect: (modelId: string) => void;
}

/**
 * Format a number with commas for thousands.
 */
function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Model selector modal with search, quick-select buttons, and model details.
 */
export function ModelSelectorModal({
  open,
  onOpenChange,
  models,
  selectedId,
  onSelect,
}: ModelSelectorModalProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [focusedModelId, setFocusedModelId] = React.useState(selectedId);
  const [sortField, setSortField] = React.useState<SortField>(null);
  const [sortDirection, setSortDirection] = React.useState<SortDirection>('asc');

  // Reset focused model when modal opens
  React.useEffect(() => {
    if (open) {
      setFocusedModelId(selectedId);
      setSearchQuery('');
    }
  }, [open, selectedId]);

  // Filter and sort models
  const filteredModels = React.useMemo(() => {
    let result = models;

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (model) =>
          model.name.toLowerCase().includes(query) || model.provider.toLowerCase().includes(query)
      );
    }

    // Sort if a sort field is active
    if (sortField) {
      result = [...result].sort((a, b) => {
        let comparison = 0;
        if (sortField === 'price') {
          const priceA = a.pricePerInputToken + a.pricePerOutputToken;
          const priceB = b.pricePerInputToken + b.pricePerOutputToken;
          comparison = priceA - priceB;
        } else {
          comparison = a.contextLength - b.contextLength;
        }
        return sortDirection === 'asc' ? comparison : -comparison;
      });
    }

    return result;
  }, [models, searchQuery, sortField, sortDirection]);

  const handleSortClick = (field: 'price' | 'context'): void => {
    if (sortField === field) {
      // Toggle direction if same field
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      // Activate new field with ascending
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Get the focused model for details panel
  const focusedModel = models.find((m) => m.id === focusedModelId) ?? models[0];

  const handleModelClick = (modelId: string): void => {
    setFocusedModelId(modelId);
  };

  const handleModelDoubleClick = (modelId: string): void => {
    onSelect(modelId);
    onOpenChange(false);
  };

  const handleQuickSelect = (modelId: string): void => {
    onSelect(modelId);
    onOpenChange(false);
  };

  return (
    <ModalOverlay open={open} onOpenChange={onOpenChange}>
      <div
        className="bg-background flex h-[80vh] w-[90vw] max-w-4xl flex-col overflow-hidden rounded-lg border shadow-lg"
        role="dialog"
        aria-label="Select model"
      >
        {/* Main content area - side by side on desktop */}
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Left panel: Search + Quick select + Sort + Model list */}
          <div className="border-border-strong flex flex-1 flex-col border-b sm:border-r sm:border-b-0">
            {/* Search input */}
            <div className="border-border-strong border-b p-4">
              <div className="relative">
                <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                <Input
                  type="text"
                  placeholder="Search models"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                  }}
                  className="pl-9"
                />
              </div>
            </div>

            {/* Quick select buttons */}
            <div className="border-border-strong border-b p-4">
              <div className="text-muted-foreground mb-2 text-xs font-medium uppercase">
                Quick Select Model
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    handleQuickSelect(STRONGEST_MODEL_ID);
                  }}
                  className="flex-1"
                >
                  Strongest
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    handleQuickSelect(VALUE_MODEL_ID);
                  }}
                  className="flex-1"
                >
                  Value
                </Button>
              </div>
            </div>

            {/* Sort by section */}
            <div className="border-border-strong border-b p-4">
              <div className="text-muted-foreground mb-2 text-xs font-medium uppercase">
                Sort By
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={sortField === 'price' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    handleSortClick('price');
                  }}
                  className="gap-1"
                  data-active={sortField === 'price'}
                  data-direction={sortField === 'price' ? sortDirection : undefined}
                >
                  Price
                  {sortField === 'price' &&
                    (sortDirection === 'asc' ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    ))}
                </Button>
                <Button
                  variant={sortField === 'context' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    handleSortClick('context');
                  }}
                  className="gap-1"
                  data-active={sortField === 'context'}
                  data-direction={sortField === 'context' ? sortDirection : undefined}
                >
                  Context
                  {sortField === 'context' &&
                    (sortDirection === 'asc' ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    ))}
                </Button>
              </div>
            </div>

            {/* Model list */}
            <ScrollArea className="flex-1">
              <div className="p-2">
                {filteredModels.map((model) => (
                  <div
                    key={model.id}
                    data-testid={`model-item-${model.id}`}
                    data-selected={model.id === focusedModelId}
                    onClick={() => {
                      handleModelClick(model.id);
                    }}
                    onDoubleClick={() => {
                      handleModelDoubleClick(model.id);
                    }}
                    className={`cursor-pointer rounded-md p-3 transition-colors ${
                      model.id === focusedModelId
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted'
                    }`}
                    role="option"
                    aria-selected={model.id === focusedModelId}
                  >
                    <div className="font-medium">{model.name}</div>
                    <div className="text-muted-foreground text-xs">
                      {model.provider} • {formatContextLength(model.contextLength)}
                    </div>
                  </div>
                ))}
                {filteredModels.length === 0 && (
                  <div className="text-muted-foreground p-4 text-center text-sm">
                    No models found
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Right panel: Model details */}
          <div className="flex-1 overflow-y-auto p-6 sm:max-w-sm">
            {focusedModel && (
              <div className="space-y-6">
                {/* Provider */}
                <div>
                  <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                    Provider
                  </div>
                  <div className="text-lg font-medium">{focusedModel.provider}</div>
                </div>

                {/* Input Price */}
                <div>
                  <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                    Input Price / Token
                  </div>
                  <div className="text-lg font-medium">
                    {formatPricePer1k(focusedModel.pricePerInputToken)} / 1k
                  </div>
                </div>

                {/* Output Price */}
                <div>
                  <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                    Output Price / Token
                  </div>
                  <div className="text-lg font-medium">
                    {formatPricePer1k(focusedModel.pricePerOutputToken)} / 1k
                  </div>
                </div>

                {/* Context Limit */}
                <div>
                  <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                    Context Limit
                  </div>
                  <div className="text-lg font-medium">
                    {formatNumber(focusedModel.contextLength)} tokens
                  </div>
                </div>

                {/* Capabilities */}
                {focusedModel.capabilities.length > 0 && (
                  <div>
                    <div className="text-muted-foreground mb-2 text-xs font-medium uppercase">
                      Capabilities
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {focusedModel.capabilities.map((cap) => (
                        <Badge key={cap} variant="secondary">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Description */}
                <div>
                  <div className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                    Description
                  </div>
                  <div className="text-sm">{focusedModel.description}</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Bottom button - full width */}
        <div className="border-t p-4">
          <Button
            variant="default"
            onClick={() => {
              onSelect(focusedModelId);
              onOpenChange(false);
            }}
            className="w-full"
          >
            Select model
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
