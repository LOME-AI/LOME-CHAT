import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelSelectorModal } from './model-selector-modal';
import type { Model } from '@lome-chat/shared';

const mockModels: Model[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'OpenAI',
    contextLength: 128000,
    pricePerInputToken: 0.00001,
    pricePerOutputToken: 0.00003,
    capabilities: ['vision', 'functions', 'json-mode', 'streaming'],
    description: 'A powerful language model from OpenAI.',
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    contextLength: 200000,
    pricePerInputToken: 0.000003,
    pricePerOutputToken: 0.000015,
    capabilities: ['vision', 'functions', 'streaming'],
    description: 'Anthropic most intelligent model.',
  },
  {
    id: 'meta-llama/llama-3.1-70b-instruct',
    name: 'Llama 3.1 70B',
    provider: 'Meta',
    contextLength: 131072,
    pricePerInputToken: 0.00000059,
    pricePerOutputToken: 0.00000079,
    capabilities: ['functions', 'streaming'],
    description: 'Open-weight model offering excellent performance.',
  },
];

describe('ModelSelectorModal', () => {
  it('renders all models when open', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('GPT-4 Turbo')).toBeInTheDocument();
    expect(screen.getByText('Claude 3.5 Sonnet')).toBeInTheDocument();
    expect(screen.getByText('Llama 3.1 70B')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <ModelSelectorModal
        open={false}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.queryByText('GPT-4 Turbo')).not.toBeInTheDocument();
  });

  it('filters models when searching', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    const searchInput = screen.getByPlaceholderText('Search models');
    await user.type(searchInput, 'Claude');

    expect(screen.getByText('Claude 3.5 Sonnet')).toBeInTheDocument();
    expect(screen.queryByText('GPT-4 Turbo')).not.toBeInTheDocument();
    expect(screen.queryByText('Llama 3.1 70B')).not.toBeInTheDocument();
  });

  it('filters models by provider', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    const searchInput = screen.getByPlaceholderText('Search models');
    await user.type(searchInput, 'openai');

    expect(screen.getByText('GPT-4 Turbo')).toBeInTheDocument();
    expect(screen.queryByText('Claude 3.5 Sonnet')).not.toBeInTheDocument();
  });

  it('shows model details when model is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    await user.click(screen.getByText('Claude 3.5 Sonnet'));

    // Should show details for Claude
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText(/200,000 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/Anthropic most intelligent model/)).toBeInTheDocument();
  });

  it('calls onSelect and closes when model is double-clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={onSelect}
      />
    );

    await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));

    expect(onSelect).toHaveBeenCalledWith('anthropic/claude-3.5-sonnet');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders Quick Select Model header', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText(/quick select model/i)).toBeInTheDocument();
  });

  it('renders Strongest button', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /strongest/i })).toBeInTheDocument();
  });

  it('renders Value button', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /value/i })).toBeInTheDocument();
  });

  it('selects strongest model and closes when Strongest button is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByRole('button', { name: /strongest/i }));

    expect(onSelect).toHaveBeenCalledWith('anthropic/claude-3.5-sonnet');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('selects value model and closes when Value button is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByRole('button', { name: /value/i }));

    expect(onSelect).toHaveBeenCalledWith('meta-llama/llama-3.1-70b-instruct');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows selected model highlighted', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    const selectedItem = screen.getByTestId('model-item-openai/gpt-4-turbo');
    expect(selectedItem).toHaveAttribute('data-selected', 'true');
  });

  it('shows details for initially selected model', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    // Should show details for the initially selected GPT-4 Turbo
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText(/A powerful language model/)).toBeInTheDocument();
  });

  it('displays capability badges', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    // GPT-4 has vision capability
    expect(screen.getByText('vision')).toBeInTheDocument();
  });

  it('formats context length correctly', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    // 128000 should be formatted as "128,000 tokens"
    expect(screen.getByText(/128,000 tokens/)).toBeInTheDocument();
  });

  it('closes on Escape key', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('renders Select model button at bottom', () => {
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={vi.fn()}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /select model/i })).toBeInTheDocument();
  });

  it('selects focused model and closes when Select model button is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <ModelSelectorModal
        open={true}
        onOpenChange={onOpenChange}
        models={mockModels}
        selectedId="openai/gpt-4-turbo"
        onSelect={onSelect}
      />
    );

    // Click a different model to focus it
    await user.click(screen.getByText('Claude 3.5 Sonnet'));

    // Click Select model button
    await user.click(screen.getByRole('button', { name: /select model/i }));

    expect(onSelect).toHaveBeenCalledWith('anthropic/claude-3.5-sonnet');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe('sorting', () => {
    it('renders Sort By section with Price and Context buttons', () => {
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      expect(screen.getByText(/sort by/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /price/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /context/i })).toBeInTheDocument();
    });

    it('highlights Price button when clicked', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      const priceButton = screen.getByRole('button', { name: /price/i });
      await user.click(priceButton);

      expect(priceButton).toHaveAttribute('data-active', 'true');
    });

    it('toggles arrow direction when active button is clicked again', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      const priceButton = screen.getByRole('button', { name: /price/i });

      // First click - activates with ascending
      await user.click(priceButton);
      expect(priceButton).toHaveAttribute('data-direction', 'asc');

      // Second click - toggles to descending
      await user.click(priceButton);
      expect(priceButton).toHaveAttribute('data-direction', 'desc');
    });

    it('sorts models by price (input + output) ascending', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByRole('button', { name: /price/i }));

      // Llama has lowest price, should be first
      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('Llama 3.1 70B');
    });

    it('sorts models by context length ascending', async () => {
      const user = userEvent.setup();
      render(
        <ModelSelectorModal
          open={true}
          onOpenChange={vi.fn()}
          models={mockModels}
          selectedId="openai/gpt-4-turbo"
          onSelect={vi.fn()}
        />
      );

      await user.click(screen.getByRole('button', { name: /context/i }));

      // GPT-4 has 128000, should be first (smallest)
      const modelItems = screen.getAllByRole('option');
      expect(modelItems[0]).toHaveTextContent('GPT-4 Turbo');
    });
  });
});
