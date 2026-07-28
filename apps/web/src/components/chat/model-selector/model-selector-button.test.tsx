import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelectorButton } from '@/components/chat/model-selector/model-selector-button';
import type { Model } from '@hushbox/shared';

// The modal's floor hook rides the billing query stack — irrelevant to the
// button's own behavior, so it is mocked at the module seam.
// The picker's verdict source. Mocked here so this stays a unit test of the
// BUTTON: the real hook reaches react-query, the catalog and the model store.
vi.mock('@/hooks/billing/use-turn-options', () => ({
  useTurnOptions: () => ({
    isPending: false,
    options: { affordable: { all: [] } },
  }),
}));

// Mock models hook to break the import chain that requires VITE_API_URL
vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({
    data: { models: [], premiumIds: new Set() },
    isLoading: false,
  }),
  getAccessibleModelIds: (
    _models: unknown[],
    _premiumIds: Set<string>,
    _canAccessPremium: boolean
  ) => ({
    strongestId: 'openai/gpt-4-turbo',
    valueId: 'openai/gpt-4-turbo',
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

const mockModels: Model[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'OpenAI',
    modality: 'text' as const,
    contextLength: 128_000,
    capabilities: [],
    description: 'A powerful language model from OpenAI.',
    supportedParameters: [],
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    modality: 'text' as const,
    contextLength: 200_000,
    capabilities: [],
    description: 'Anthropic most intelligent model.',
    supportedParameters: [],
    pricing: { inputPerToken: '3000', outputPerToken: '15000' },
  },
];

describe('ModelSelectorButton', () => {
  it('renders with selected model name', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('GPT-4 Turbo');
  });

  it('shows default model name when selectedModels is empty', () => {
    render(<ModelSelectorButton models={mockModels} selectedModels={[]} onSelect={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveTextContent('Smart Model');
  });

  it('opens modal when clicked', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText('Search models').length).toBeGreaterThan(0);
    });
  });

  it('closes modal after selection in default single mode (row click commits)', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByRole('button'));

    // Wait for modal to open (search input appears twice for mobile/desktop)
    await waitFor(() => {
      expect(screen.getAllByPlaceholderText('Search models').length).toBeGreaterThan(0);
    });

    // Single mode: clicking a row commits + closes immediately
    await user.click(screen.getByText('Claude 3.5 Sonnet'));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search models')).not.toBeInTheDocument();
    });

    expect(onSelect).toHaveBeenCalledWith([
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
    ]);
  });

  it('is disabled when disabled prop is true', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
        disabled
      />
    );

    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('does not open modal when disabled', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
        disabled
      />
    );

    await user.click(screen.getByRole('button'));

    expect(screen.queryByPlaceholderText('Search models')).not.toBeInTheDocument();
  });

  it('has accessible name including the current selection', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveAccessibleName(/select model.*current.*GPT-4 Turbo/i);
  });

  it('reflects the selected count in the accessible name when 2+ models are selected', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
        ]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveAccessibleName(/select model.*current.*2 models/i);
  });

  it('has centered text', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('model-selector-button')).toHaveClass('justify-center');
  });

  it('displays "Smart Model" when the Smart Model is selected', () => {
    const modelsWithSmartModel: Model[] = [
      ...mockModels,
      {
        id: 'smart-model',
        name: 'Smart Model',
        provider: 'HushBox',
        modality: 'text' as const,
        contextLength: 2_000_000,
        capabilities: [],
        description: 'Uses the best model for your task',
        supportedParameters: [],
        isSmartModel: true,
        pricing: { inputPerToken: '39', outputPerToken: '190' },
      },
    ];

    render(
      <ModelSelectorButton
        models={modelsWithSmartModel}
        selectedModels={[{ id: 'smart-model', name: 'Smart Model' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('Smart Model');
  });

  it('displays fallback name for Smart Model before models load', () => {
    render(
      <ModelSelectorButton
        models={[]}
        selectedModels={[{ id: 'smart-model', name: 'Smart Model' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('Smart Model');
  });

  it('displays the selected count when 2+ models selected', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
        ]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('2 models');
  });

  it('displays "3 models" when 3 models selected', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
          { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B' },
        ]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('3 models');
  });

  it('displays shortened model name when 1 model selected via selectedModels', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button')).toHaveTextContent('GPT-4 Turbo');
  });

  it('exposes aria-haspopup="dialog" so screen readers announce a popup trigger', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('model-selector-button')).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('exposes a stable HTML id for Maestro mobile tests that select by DOM id', () => {
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByTestId('model-selector-button')).toHaveAttribute(
      'id',
      'model-selector-button'
    );
  });

  it('reflects open/closed state via aria-expanded', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorButton
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onSelect={vi.fn()}
      />
    );

    const trigger = screen.getByTestId('model-selector-button');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    await waitFor(() => {
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('controlled open state', () => {
    it('opens the modal when the open prop is true', () => {
      render(
        <ModelSelectorButton
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onSelect={vi.fn()}
          open={true}
          onOpenChange={vi.fn()}
        />
      );

      expect(screen.getAllByPlaceholderText('Search models').length).toBeGreaterThan(0);
    });

    it('keeps the modal closed when the open prop is false', () => {
      render(
        <ModelSelectorButton
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onSelect={vi.fn()}
          open={false}
          onOpenChange={vi.fn()}
        />
      );

      expect(screen.queryByPlaceholderText('Search models')).not.toBeInTheDocument();
    });

    it('calls onOpenChange when the trigger button is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(
        <ModelSelectorButton
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onSelect={vi.fn()}
          open={false}
          onOpenChange={onOpenChange}
        />
      );

      await user.click(screen.getByTestId('model-selector-button'));
      expect(onOpenChange).toHaveBeenCalledWith(true);
    });

    it('falls back to internal state when open prop is undefined', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorButton
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onSelect={vi.fn()}
        />
      );

      expect(screen.queryByPlaceholderText('Search models')).not.toBeInTheDocument();
      await user.click(screen.getByTestId('model-selector-button'));
      await waitFor(() => {
        expect(screen.getAllByPlaceholderText('Search models').length).toBeGreaterThan(0);
      });
    });
  });
});
