import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MAX_SELECTED_MODELS, type Model } from '@hushbox/shared';
import { ModelListBody } from '@/components/chat/model-selector/model-list-body';
import type { ModelListBodyProps } from '@/components/chat/model-selector/model-list-body';

vi.mock('@/components/chat/model-selector/model-list-item', () => ({
  ModelListItem: ({ model, isDisabled }: { model: Model; isDisabled: boolean }) => (
    <div data-testid={`item-${model.id}`} data-disabled={String(isDisabled)}>
      {model.name}
    </div>
  ),
}));

function makeModel(id: string): Model {
  return {
    id,
    name: `Model ${id}`,
    description: '',
    provider: 'p',
    modality: 'text',
    contextLength: 1000,
    pricing: { inputPerToken: '10000', outputPerToken: '20000' },
  } as unknown as Model;
}

function baseProps(overrides: Partial<ModelListBodyProps> = {}): ModelListBodyProps {
  return {
    filteredModels: [makeModel('a'), makeModel('b')],
    pickerMode: 'single',
    selectedIds: new Set<string>(),
    localSelectedIds: new Set<string>(),
    focusedModelId: '',
    expandedModelId: null,
    isPremium: () => false,
    isBelowFloor: () => false,
    canAccessPremium: true,
    isAuthenticated: true,
    isLinkGuest: false,
    isMobile: false,
    pulsingModelId: null,
    getPinnedLabel: () => {},
    onActivate: vi.fn(),
    onHover: vi.fn(),
    onShowInfo: vi.fn(),
    onToggleExpand: vi.fn(),
    ...overrides,
  };
}

describe('ModelListBody', () => {
  it('renders one row per filtered model', () => {
    render(<ModelListBody {...baseProps()} />);
    expect(screen.getByTestId('item-a')).toBeInTheDocument();
    expect(screen.getByTestId('item-b')).toBeInTheDocument();
  });

  it('disables unselected rows once the multi-select limit is reached', () => {
    const selected = new Set(
      Array.from({ length: MAX_SELECTED_MODELS }, (_v, index) => `sel-${String(index)}`)
    );
    const models = [...[...selected].map((id) => makeModel(id)), makeModel('extra')];

    render(
      <ModelListBody
        {...baseProps({ pickerMode: 'multi', localSelectedIds: selected, filteredModels: models })}
      />
    );

    expect(screen.getByTestId('item-extra')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('item-sel-0')).toHaveAttribute('data-disabled', 'false');
  });

  it('shows an empty state when there are no models', () => {
    render(<ModelListBody {...baseProps({ filteredModels: [] })} />);
    expect(screen.getByText('No models found')).toBeInTheDocument();
  });
});
