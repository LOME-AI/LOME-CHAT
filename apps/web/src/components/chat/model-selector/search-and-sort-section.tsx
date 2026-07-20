import * as React from 'react';
import { Search, ChevronUp, ChevronDown } from 'lucide-react';
import { Input, Button, cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';

import type {
  SortField,
  SortDirection,
} from '@/components/chat/model-selector/model-selector-helpers';
import type { ChatModality } from '@hushbox/shared';

interface SortButtonProps {
  field: 'price' | 'context';
  label: string;
  activeField: SortField;
  direction: SortDirection;
  onClick: (field: 'price' | 'context') => void;
}

function SortButton({
  field,
  label,
  activeField,
  direction,
  onClick,
}: Readonly<SortButtonProps>): React.JSX.Element {
  const isActive = activeField === field;
  return (
    <Button
      variant={isActive ? 'default' : 'outline'}
      size="sm"
      onClick={() => {
        onClick(field);
      }}
      className="w-full gap-1"
      data-active={isActive}
      data-direction={isActive ? direction : undefined}
    >
      {label}
      {isActive &&
        (direction === 'asc' ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        ))}
    </Button>
  );
}

export interface SearchAndSortSectionProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  onSortClick: (field: 'price' | 'context') => void;
  activeModality: ChatModality;
  /**
   * Optional element rendered to the right of the search input. Width animates
   * via the consumer (typically the multi-mode count chip).
   */
  rightAccessory?: React.ReactNode;
  /**
   * When false, omits the bottom divider so the section sits flush against the
   * parent's own border (used when wrapped in DesktopTopQuadrant, which owns
   * the divider for both desktop top quadrants).
   */
  withBottomBorder?: boolean;
}

export function SearchAndSortSection({
  searchQuery,
  onSearchChange,
  sortField,
  sortDirection,
  onSortClick,
  activeModality,
  rightAccessory,
  withBottomBorder = true,
}: Readonly<SearchAndSortSectionProps>): React.JSX.Element {
  const showCapacityButton = activeModality === 'text';
  return (
    <div className={cn('border-border-strong space-y-2 px-4 py-2', withBottomBorder && 'border-b')}>
      <div
        className={cn(
          'items-center gap-2 pr-8 sm:pr-0',
          showCapacityButton ? 'grid grid-cols-[auto_1fr_1fr]' : 'grid grid-cols-[auto_1fr]'
        )}
      >
        <span className="text-muted-foreground text-xs font-medium">Sort:</span>
        <SortButton
          field="price"
          label="Price"
          activeField={sortField}
          direction={sortDirection}
          onClick={onSortClick}
        />
        {showCapacityButton && (
          <SortButton
            field="context"
            label="Capacity"
            activeField={sortField}
            direction={sortDirection}
            onClick={onSortClick}
          />
        )}
      </div>
      <div data-testid={TEST_IDS.searchAndSortRow} className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            type="text"
            placeholder="Search models"
            value={searchQuery}
            onChange={(e) => {
              onSearchChange(e.target.value);
            }}
            className="pl-9"
          />
        </div>
        {rightAccessory}
      </div>
    </div>
  );
}
