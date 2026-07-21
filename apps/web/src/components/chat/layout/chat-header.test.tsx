import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatHeader } from '@/components/chat/layout/chat-header';
import type { Model } from '@hushbox/shared';

vi.mock('@/components/providers/theme-provider', () => ({
  useTheme: () => ({
    mode: 'light',
    triggerTransition: vi.fn(),
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

// Mock useHeaderLayout (ResizeObserver not available in jsdom)
vi.mock('@/hooks/ui/use-header-layout', () => ({
  useHeaderLayout: () => 1,
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
    description: 'Test description for GPT-4 Turbo.',
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
    description: 'Test description for Claude 3.5 Sonnet.',
    supportedParameters: [],
    pricing: { inputPerToken: '3000', outputPerToken: '15000' },
  },
];

describe('ChatHeader', () => {
  it('renders hamburger button for mobile navigation', () => {
    render(
      <ChatHeader
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onModelSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId('hamburger-button')).toBeInTheDocument();
  });

  it('renders theme toggle', () => {
    render(
      <ChatHeader
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onModelSelect={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it('renders encryption badge', () => {
    render(
      <ChatHeader
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onModelSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId('encryption-badge')).toBeInTheDocument();
  });

  it('has sticky positioning', () => {
    render(
      <ChatHeader
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
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
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onModelSelect={vi.fn()}
      />
    );
    const header = screen.getByTestId('chat-header');
    expect(header).toHaveClass('border-b');
  });

  it('has proper padding and height', () => {
    render(
      <ChatHeader
        models={mockModels}
        selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
        onModelSelect={vi.fn()}
      />
    );
    const header = screen.getByTestId('chat-header');
    expect(header).toHaveClass('px-4');
    expect(header).toHaveClass('min-h-[var(--app-header-height)]');
  });

  describe('model selector', () => {
    it('renders model selector button in header', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onModelSelect={vi.fn()}
        />
      );
      expect(screen.getByTestId('model-selector-button')).toBeInTheDocument();
    });

    it('displays selected model name', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onModelSelect={vi.fn()}
        />
      );
      expect(screen.getByTestId('model-selector-button')).toHaveTextContent('GPT-4 Turbo');
    });

    it('calls onModelSelect when model is changed in default single mode', async () => {
      const user = userEvent.setup();
      const onModelSelect = vi.fn();
      render(
        <ChatHeader
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onModelSelect={onModelSelect}
        />
      );

      await user.click(screen.getByTestId('model-selector-button'));

      // Wait for modal to open (search input appears twice for mobile/desktop)
      await waitFor(() => {
        expect(screen.getAllByPlaceholderText('Search models').length).toBeGreaterThan(0);
      });

      // Single mode: row click commits + closes immediately
      await user.click(screen.getByText('Claude 3.5 Sonnet'));

      expect(onModelSelect).toHaveBeenCalledWith([
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      ]);
    });

    it('centers model selector via CSS Grid columns', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onModelSelect={vi.fn()}
        />
      );
      // Centering is via CSS Grid 1fr auto 1fr — center column in the grid
      const grid = screen.getByTestId('chat-header-grid');
      expect(grid.style.gridTemplateColumns).toBe('1fr auto 1fr');
    });
  });

  describe('title', () => {
    it('renders title when provided', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
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
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onModelSelect={vi.fn()}
        />
      );
      expect(screen.queryByTestId('chat-title')).not.toBeInTheDocument();
    });

    it('has truncate class for long titles', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
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
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
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
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onModelSelect={vi.fn()}
          title="Test Conversation"
        />
      );
      const title = screen.getByTestId('chat-title');
      expect(title).toHaveClass('hidden');
      expect(title).toHaveClass('md:block');
    });

    it('uses brand color for title', () => {
      render(
        <ChatHeader
          models={mockModels}
          selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
          onModelSelect={vi.fn()}
          title="Test Conversation"
        />
      );
      const title = screen.getByTestId('chat-title');
      expect(title).toHaveClass('text-primary');
    });
  });

  describe('group chat features', () => {
    const groupMembers = [
      { id: 'user-1', userId: 'user-1', username: 'alice' },
      { id: 'user-2', userId: 'user-2', username: 'bob' },
    ];

    describe('facepile', () => {
      it('renders facepile when members are provided', () => {
        render(
          <ChatHeader
            models={mockModels}
            selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
            onModelSelect={vi.fn()}
            members={groupMembers}
            onlineMemberIds={new Set()}
            onFacepileClick={vi.fn()}
          />
        );
        expect(screen.getByTestId('member-facepile')).toBeInTheDocument();
      });

      it('does not render facepile when members is undefined', () => {
        render(
          <ChatHeader
            models={mockModels}
            selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
            onModelSelect={vi.fn()}
          />
        );
        expect(screen.queryByTestId('member-facepile')).not.toBeInTheDocument();
      });

      it('does not render facepile when members is empty', () => {
        render(
          <ChatHeader
            models={mockModels}
            selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
            onModelSelect={vi.fn()}
            members={[]}
            onlineMemberIds={new Set()}
            onFacepileClick={vi.fn()}
          />
        );
        expect(screen.queryByTestId('member-facepile')).not.toBeInTheDocument();
      });

      it('calls onFacepileClick when facepile is clicked', async () => {
        const user = userEvent.setup();
        const onFacepileClick = vi.fn();
        render(
          <ChatHeader
            models={mockModels}
            selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
            onModelSelect={vi.fn()}
            members={groupMembers}
            onlineMemberIds={new Set()}
            onFacepileClick={onFacepileClick}
          />
        );
        await user.click(screen.getByTestId('member-facepile'));
        expect(onFacepileClick).toHaveBeenCalledOnce();
      });

      it('renders the facepile with fallbacks when presence and click handler are omitted', async () => {
        const user = userEvent.setup();
        render(
          <ChatHeader
            models={mockModels}
            selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
            onModelSelect={vi.fn()}
            members={groupMembers}
          />
        );
        const facepile = screen.getByTestId('member-facepile');
        expect(facepile).toBeInTheDocument();
        // The noop fallback must be safe to invoke.
        await expect(user.click(facepile)).resolves.toBeUndefined();
      });
    });

    describe('icon ordering', () => {
      it('renders EncryptionBadge, ThemeToggle, and Facepile in correct order', () => {
        render(
          <ChatHeader
            models={mockModels}
            selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
            onModelSelect={vi.fn()}
            members={groupMembers}
            onlineMemberIds={new Set()}
            onFacepileClick={vi.fn()}
          />
        );
        const encBadge = screen.getByTestId('encryption-badge');
        const themeButton = screen.getByRole('button', { name: /switch to dark mode/i });
        const facepile = screen.getByTestId('member-facepile');

        const parent = encBadge.parentElement!;
        const children = [...parent.children];
        const encIndex = children.indexOf(encBadge);
        const themeIndex = children.indexOf(themeButton);
        const facepileIndex = children.indexOf(facepile);

        expect(encIndex).toBeLessThan(facepileIndex);
        expect(themeIndex).toBeLessThan(facepileIndex);
      });

      it('does not render add dropdown', () => {
        render(
          <ChatHeader
            models={mockModels}
            selectedModels={[{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }]}
            onModelSelect={vi.fn()}
            members={groupMembers}
            onlineMemberIds={new Set()}
            onFacepileClick={vi.fn()}
          />
        );
        expect(screen.queryByTestId('header-add-dropdown-trigger')).not.toBeInTheDocument();
      });
    });
  });
});
