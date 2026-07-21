import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComparisonBar } from '@/components/chat/layout/comparison-bar';
import type { Model } from '@hushbox/shared';

vi.mock('@hushbox/shared', async () => {
  const actual = await vi.importActual<typeof import('@hushbox/shared')>('@hushbox/shared');
  return {
    ...actual,
    shortenModelName: (name: string) => name,
  };
});

function buildModel(id: string, name: string, overrides: Partial<Model> = {}): Model {
  return {
    id,
    name,
    provider: 'TestProvider',
    modality: 'text' as const,
    contextLength: 128_000,
    pricing: { inputPerToken: '2500', outputPerToken: '10000' },
    capabilities: [],
    description: `Description for ${name}`,
    supportedParameters: [],
    ...overrides,
  };
}

const fullModels: Model[] = [
  buildModel('model-a', 'Model A', { provider: 'ProviderA' }),
  buildModel('model-b', 'Model B', { provider: 'ProviderB' }),
  buildModel('model-c', 'Model C'),
];

describe('ComparisonBar', () => {
  const twoModels = [
    { id: 'model-a', name: 'Model A' },
    { id: 'model-b', name: 'Model B' },
  ];

  it('renders null when only 1 model selected', () => {
    const { container } = render(
      <ComparisonBar
        models={fullModels}
        selectedModels={[{ id: 'model-a', name: 'Model A' }]}
        onRemoveModel={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders model pills when 2+ models selected', () => {
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={vi.fn()} />
    );
    expect(screen.getByText('Model A')).toBeInTheDocument();
    expect(screen.getByText('Model B')).toBeInTheDocument();
  });

  it('renders remove buttons for each model', () => {
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={vi.fn()} />
    );
    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    expect(removeButtons).toHaveLength(2);
  });

  it('calls onRemoveModel when remove button clicked', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={onRemove} />
    );
    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    await user.click(removeButtons[0]!);
    expect(onRemove).toHaveBeenCalledWith('model-a');
  });

  it('has data-testid on the bar', () => {
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={vi.fn()} />
    );
    expect(screen.getByTestId('selected-models-bar')).toBeInTheDocument();
  });

  it('applies model-derived color to pills via CSS custom properties', () => {
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={vi.fn()} />
    );
    const pillA = screen.getByText('Model A').closest('[style]')!;
    expect(pillA).toBeTruthy();
    expect(pillA.getAttribute('style')).toContain('--pill-bg');
    expect(pillA.getAttribute('style')).toContain('--pill-fg');
  });

  it('shows model info popover on hover', async () => {
    const user = userEvent.setup();
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={vi.fn()} />
    );
    const pillA = screen.getByText('Model A');
    await user.hover(pillA);
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('ProviderA');
    expect(tooltip).toHaveTextContent('Input Price / Token');
  });

  it('opens the model info tooltip when the trigger receives keyboard focus', async () => {
    const user = userEvent.setup();
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={vi.fn()} />
    );
    await user.tab();
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent('ProviderA');
  });

  it('closes the model info tooltip when the trigger loses focus', async () => {
    const user = userEvent.setup();
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={vi.fn()} />
    );
    await user.tab();
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    });
    await user.tab();
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
  });

  it('shows compact info without description', async () => {
    const user = userEvent.setup();
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={vi.fn()} />
    );
    const pillA = screen.getByText('Model A');
    await user.hover(pillA);
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).not.toHaveTextContent('Description for Model A');
  });

  it('remove button works while tooltip is open', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={onRemove} />
    );
    const pillA = screen.getByText('Model A');
    await user.hover(pillA);
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    });
    const removeButton = screen.getAllByRole('button', { name: /remove model a/i })[0]!;
    await user.click(removeButton);
    expect(onRemove).toHaveBeenCalledWith('model-a');
  });

  it('renders without tooltip when model not found in models list', () => {
    render(<ComparisonBar models={[]} selectedModels={twoModels} onRemoveModel={vi.fn()} />);
    expect(screen.getByText('Model A')).toBeInTheDocument();
    expect(screen.getByText('Model B')).toBeInTheDocument();
  });

  it('does not render the +Add chip when onAddClick is not provided', () => {
    render(
      <ComparisonBar models={fullModels} selectedModels={twoModels} onRemoveModel={vi.fn()} />
    );
    expect(screen.queryByTestId('comparison-bar-add-button')).not.toBeInTheDocument();
  });

  it('renders the +Add chip when onAddClick is provided', () => {
    render(
      <ComparisonBar
        models={fullModels}
        selectedModels={twoModels}
        onRemoveModel={vi.fn()}
        onAddClick={vi.fn()}
      />
    );
    expect(screen.getByTestId('comparison-bar-add-button')).toBeInTheDocument();
  });

  it('calls onAddClick when the +Add chip is clicked', async () => {
    const user = userEvent.setup();
    const onAddClick = vi.fn();
    render(
      <ComparisonBar
        models={fullModels}
        selectedModels={twoModels}
        onRemoveModel={vi.fn()}
        onAddClick={onAddClick}
      />
    );
    await user.click(screen.getByTestId('comparison-bar-add-button'));
    expect(onAddClick).toHaveBeenCalledTimes(1);
  });
});
