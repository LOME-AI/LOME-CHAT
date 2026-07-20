import * as React from 'react';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@hushbox/ui';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';

export type DateRangePreset = '7d' | '30d' | '90d' | 'all';

interface UsageFiltersProps {
  range: DateRangePreset;
  onRangeChange: (range: DateRangePreset) => void;
  model: string | undefined;
  onModelChange: (model: string | undefined) => void;
  availableModels: readonly string[];
}

const PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
];

export function UsageFilters({
  range,
  onRangeChange,
  model,
  onModelChange,
  availableModels,
}: Readonly<UsageFiltersProps>): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid={TEST_IDS.usageFilters}>
      <div className="flex gap-1" data-testid={TEST_IDS.dateRangeButtons}>
        {PRESETS.map((preset) => (
          <Button
            key={preset.value}
            variant={range === preset.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              onRangeChange(preset.value);
            }}
            data-testid={TEST_ID_BUILDERS.range(preset.value)}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="ml-auto min-w-[160px]">
        <Select
          value={model ?? 'all'}
          onValueChange={(v) => {
            onModelChange(v === 'all' ? undefined : v);
          }}
        >
          <SelectTrigger data-testid={TEST_IDS.modelFilter}>
            <SelectValue placeholder="All Models" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Models</SelectItem>
            {availableModels.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
