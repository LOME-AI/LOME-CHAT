import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { UsageFilters, type DateRangePreset } from './usage-filters';

// Radix Select relies on pointer-capture APIs jsdom lacks, so swap the Select
// family for a native <select> that drives `onValueChange` deterministically.
// Trigger/Value render nothing to keep the <select> children valid (options only).
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (v: string) => void;
      children: React.ReactNode;
    }) => (
      <select
        data-testid="native-model-select"
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
        }}
      >
        {children}
      </select>
    ),
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
  };
});

function setup(overrides: Partial<React.ComponentProps<typeof UsageFilters>> = {}) {
  const onRangeChange = vi.fn();
  const onModelChange = vi.fn();
  const props: React.ComponentProps<typeof UsageFilters> = {
    range: '30d',
    onRangeChange,
    model: undefined,
    onModelChange,
    availableModels: ['GPT-4', 'Claude'],
    ...overrides,
  };
  render(<UsageFilters {...props} />);
  return { onRangeChange, onModelChange };
}

describe('UsageFilters', () => {
  it('renders the filter container', () => {
    setup();
    expect(screen.getByTestId(TEST_IDS.usageFilters)).toBeInTheDocument();
  });

  it('renders every date-range preset button', () => {
    setup();
    for (const preset of ['7d', '30d', '90d', 'all'] as DateRangePreset[]) {
      expect(screen.getByTestId(TEST_ID_BUILDERS.range(preset))).toBeInTheDocument();
    }
  });

  it('calls onRangeChange with the clicked preset', () => {
    const { onRangeChange } = setup();
    fireEvent.click(screen.getByTestId(TEST_ID_BUILDERS.range('7d')));
    expect(onRangeChange).toHaveBeenCalledWith('7d');
  });

  it('marks the active preset with the default variant', () => {
    setup({ range: '90d' });
    const active = screen.getByTestId(TEST_ID_BUILDERS.range('90d'));
    const inactive = screen.getByTestId(TEST_ID_BUILDERS.range('7d'));
    // The default button variant lacks the outline border class the inactive ones carry.
    expect(active.className).not.toEqual(inactive.className);
  });

  it('renders an option per available model', () => {
    setup({ availableModels: ['GPT-4', 'Claude'] });
    expect(screen.getByRole('option', { name: 'GPT-4' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Claude' })).toBeInTheDocument();
  });

  it('selects "all" when no model is set', () => {
    setup({ model: undefined });
    expect(screen.getByTestId<HTMLSelectElement>('native-model-select').value).toBe('all');
  });

  it('reflects the currently selected model', () => {
    setup({ model: 'GPT-4' });
    expect(screen.getByTestId<HTMLSelectElement>('native-model-select').value).toBe('GPT-4');
  });

  it('calls onModelChange with the chosen model', () => {
    const { onModelChange } = setup();
    fireEvent.change(screen.getByTestId('native-model-select'), { target: { value: 'Claude' } });
    expect(onModelChange).toHaveBeenCalledWith('Claude');
  });

  it('maps the "all" option back to undefined', () => {
    const { onModelChange } = setup({ model: 'GPT-4' });
    fireEvent.change(screen.getByTestId('native-model-select'), { target: { value: 'all' } });
    expect(onModelChange).toHaveBeenCalledWith(undefined);
  });
});
