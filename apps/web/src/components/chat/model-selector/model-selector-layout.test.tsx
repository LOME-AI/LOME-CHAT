import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS, type Model } from '@hushbox/shared';
import { ModelSelectorModalLayout } from '@/components/chat/model-selector/model-selector-layout';
import type { ModelSelectorModalLayoutProps } from '@/components/chat/model-selector/model-selector-layout';
import type { SearchAndSortSectionProps } from '@/components/chat/model-selector/search-and-sort-section';
import type { ModelListBodyProps } from '@/components/chat/model-selector/model-list-body';

vi.mock('@/components/chat/model-selector/model-info-panel', () => ({
  ModelInfoPanel: ({ model }: { model: Model }) => (
    <div data-testid="model-info-panel">{model.name}</div>
  ),
}));

vi.mock('@/components/chat/model-selector/picker-mode-toggle', () => ({
  PickerModeToggle: () => <div data-testid="picker-mode-toggle" />,
}));

vi.mock('@/components/chat/model-selector/search-and-sort-section', () => ({
  SearchAndSortSection: () => <div data-testid="search-and-sort" />,
}));

vi.mock('@/components/chat/model-selector/model-list-body', () => ({
  ModelListBody: () => <div data-testid="model-list-body" />,
}));

const searchAndSortProps = {} as unknown as SearchAndSortSectionProps;
const modelListBodyProps = {} as unknown as ModelListBodyProps;

function baseProps(
  overrides: Partial<ModelSelectorModalLayoutProps> = {}
): ModelSelectorModalLayoutProps {
  return {
    isMobile: false,
    pickerMode: 'single',
    multiLabel: 'Multi',
    searchAndSortProps,
    handleModeChange: vi.fn(),
    focusedModel: undefined,
    modelListBodyProps,
    footer: <div data-testid="footer" />,
    ...overrides,
  };
}

describe('ModelSelectorModalLayout', () => {
  it('renders the desktop details panel with model info when a model is focused', () => {
    const focusedModel = { id: 'm1', name: 'Focused Model' } as unknown as Model;
    render(<ModelSelectorModalLayout {...baseProps({ focusedModel })} />);

    expect(screen.getByTestId(TEST_IDS.modelDetailsPanel)).toBeInTheDocument();
    expect(screen.getByTestId('model-info-panel')).toHaveTextContent('Focused Model');
  });

  it('renders the desktop details panel empty when no model is focused', () => {
    render(<ModelSelectorModalLayout {...baseProps({ focusedModel: undefined })} />);

    expect(screen.getByTestId(TEST_IDS.modelDetailsPanel)).toBeInTheDocument();
    expect(screen.queryByTestId('model-info-panel')).not.toBeInTheDocument();
  });

  it('renders the mobile top section and no desktop right column on mobile', () => {
    render(<ModelSelectorModalLayout {...baseProps({ isMobile: true })} />);

    expect(screen.getByTestId(TEST_IDS.pickerModeToggleWrapper)).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.modelDetailsPanel)).not.toBeInTheDocument();
  });

  it('renders the footer', () => {
    render(<ModelSelectorModalLayout {...baseProps()} />);
    expect(screen.getByTestId('footer')).toBeInTheDocument();
  });
});
