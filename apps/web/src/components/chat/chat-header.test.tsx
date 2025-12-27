import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatHeader } from './chat-header';
import type { Model } from '@lome-chat/shared';

// Mock the theme provider
vi.mock('../providers/theme-provider', () => ({
  useTheme: () => ({
    mode: 'light',
    triggerTransition: vi.fn(),
  }),
}));

const mockModels: Model[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'OpenAI',
    contextLength: 128000,
    pricePerInputToken: 0.00001,
    pricePerOutputToken: 0.00003,
    capabilities: ['vision', 'functions', 'streaming'],
    description: 'Test description for GPT-4 Turbo.',
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    contextLength: 200000,
    pricePerInputToken: 0.000003,
    pricePerOutputToken: 0.000015,
    capabilities: ['vision', 'streaming'],
    description: 'Test description for Claude 3.5 Sonnet.',
  },
];

describe('ChatHeader', () => {
  it('renders hamburger button for mobile navigation', () => {
    render(
      <ChatHeader
        models={mockModels}
        selectedModelId="openai/gpt-4-turbo"
        onModelSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId('hamburger-button')).toBeInTheDocument();
  });

  it('renders theme toggle', () => {
    render(
      <ChatHeader
        models={mockModels}
        selectedModelId="openai/gpt-4-turbo"
        onModelSelect={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it('has sticky positioning', () => {
    render(
      <ChatHeader
        models={mockModels}
        selectedModelId="openai/gpt-4-turbo"
        onModelSelect={vi.fn()}
      />
    );
    const header = screen.getByTestId('chat-header');
    expect(header).toHaveClass('sticky');
    expect(header).toHaveClass('top-0');
  });

  it('has border bottom', () => {
    render(
      <ChatHeader
        models={mockModels}
        selectedModelId="openai/gpt-4-turbo"
        onModelSelect={vi.fn()}
      />
    );
    const header = screen.getByTestId('chat-header');
    expect(header).toHaveClass('border-b');
  });

  it('has proper padding', () => {
    render(
      <ChatHeader
        models={mockModels}
        selectedModelId="openai/gpt-4-turbo"
        onModelSelect={vi.fn()}
      />
    );
    const header = screen.getByTestId('chat-header');
    expect(header).toHaveClass('px-4');
    expect(header).toHaveClass('py-3');
  });

  describe('model selector', () => {
    it('renders model selector button in header', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModelId="openai/gpt-4-turbo"
          onModelSelect={vi.fn()}
        />
      );
      expect(screen.getByTestId('model-selector-button')).toBeInTheDocument();
    });

    it('displays selected model name', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModelId="openai/gpt-4-turbo"
          onModelSelect={vi.fn()}
        />
      );
      expect(screen.getByTestId('model-selector-button')).toHaveTextContent('GPT-4 Turbo');
    });

    it('calls onModelSelect when model is changed', async () => {
      const user = userEvent.setup();
      const onModelSelect = vi.fn();
      render(
        <ChatHeader
          models={mockModels}
          selectedModelId="openai/gpt-4-turbo"
          onModelSelect={onModelSelect}
        />
      );

      // Click button to open modal
      await user.click(screen.getByTestId('model-selector-button'));

      // Wait for modal to open
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search models')).toBeInTheDocument();
      });

      // Double-click to select the model
      await user.dblClick(screen.getByText('Claude 3.5 Sonnet'));

      expect(onModelSelect).toHaveBeenCalledWith('anthropic/claude-3.5-sonnet');
    });

    it('centers model selector in header', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModelId="openai/gpt-4-turbo"
          onModelSelect={vi.fn()}
        />
      );
      // The header should use flex with justify-center for the model selector
      const header = screen.getByTestId('chat-header');
      expect(header).toHaveClass('justify-center');
    });
  });

  describe('title', () => {
    it('renders title when provided', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModelId="openai/gpt-4-turbo"
          onModelSelect={vi.fn()}
          title="Test Conversation"
        />
      );
      expect(screen.getByText('Test Conversation')).toBeInTheDocument();
    });

    it('does not render title when not provided', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModelId="openai/gpt-4-turbo"
          onModelSelect={vi.fn()}
        />
      );
      expect(screen.queryByTestId('chat-title')).not.toBeInTheDocument();
    });

    it('has truncate class for long titles', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModelId="openai/gpt-4-turbo"
          onModelSelect={vi.fn()}
          title="A Very Long Conversation Title That Should Be Truncated"
        />
      );
      const title = screen.getByTestId('chat-title');
      expect(title).toHaveClass('truncate');
    });

    it('has title attribute for full text on hover', () => {
      const fullTitle = 'A Very Long Conversation Title That Should Be Truncated';
      render(
        <ChatHeader
          models={mockModels}
          selectedModelId="openai/gpt-4-turbo"
          onModelSelect={vi.fn()}
          title={fullTitle}
        />
      );
      const title = screen.getByTestId('chat-title');
      expect(title).toHaveAttribute('title', fullTitle);
    });

    it('is hidden on mobile with hidden md:block class', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModelId="openai/gpt-4-turbo"
          onModelSelect={vi.fn()}
          title="Test Conversation"
        />
      );
      const title = screen.getByTestId('chat-title');
      expect(title).toHaveClass('hidden');
      expect(title).toHaveClass('md:block');
    });
  });
});
