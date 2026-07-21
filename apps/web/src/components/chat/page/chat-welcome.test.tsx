import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { ChatWelcome } from '@/components/chat/page/chat-welcome';
import type { PromptBudgetResult } from '@/hooks/billing/use-prompt-budget';

// Controllable isMobile for the auto-focus effect (desktop-only behavior).
const isMobileRef = { current: false };

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: (): boolean => isMobileRef.current,
  };
});

vi.mock('@/lib/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public data?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    getSecureRandomElement: <T,>(array: readonly T[]): T => array[0] as T,
  };
});

import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

function resetModelStoreStub(): void {
  modelStoreStubRef.current = createModelStoreStub();
}

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  (store as unknown as Record<string, unknown>)['setState'] = vi.fn();
  (store as unknown as Record<string, unknown>)['getState'] = () => modelStoreStubRef.current;
  return { ...actual, useModelStore: store };
});

vi.mock('@/hooks/models/use-resolve-default-model', () => ({
  useResolveDefaultModel: () => {
    /* no-op in tests */
  },
}));

vi.mock('@/hooks/models/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/models/models')>();
  return {
    ...actual,
    useModels: vi.fn(() => ({
      data: {
        models: [
          {
            id: 'test-model',
            name: 'Test Model',
            contextLength: 50_000,
            capabilities: [],
            provider: { name: 'Test Provider' },
            description: 'A test model',
            pricing: { inputPerToken: '1000', outputPerToken: '2000' },
          },
        ],
      },
      isLoading: false,
      error: null,
    })),
  };
});

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(() => ({
    data: { user: { id: 'test-user', email: 'test@example.com' } },
    isPending: false,
  })),
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: vi.fn(() => ({
    displayBalance: '10.00',
    isStable: true,
  })),
}));

// Mock usePromptBudget directly — PromptInput's only budget dependency
vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: (input: { value: string }): PromptBudgetResult => ({
    fundingSource: 'personal_balance',
    notifications: [],
    capacityPercent: 5,
    capacityCurrentUsage: 1100,
    capacityMaxCapacity: 50_000,
    estimatedCostCents: 0.1,
    isOverCapacity: false,
    hasBlockingError: false,
    hasContent: input.value.trim().length > 0,
  }),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({ isStable: true }),
}));

vi.mock('@/components/shared/stable-content', () => ({
  StableContent: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock framer-motion to avoid animation issues in tests
vi.mock('@/components/chat/media/modality-config-panel', () => ({
  ImageAspectRatioControl: () => null,
  VideoAspectRatioControl: () => null,
  VideoResolutionControl: () => null,
  VideoDurationControl: () => null,
  AudioFormatControl: () => null,
  AudioDurationControl: () => null,
  MediaCostLine: () => null,
}));

vi.mock('framer-motion', async () => {
  const react = await import('react');

  const createMotionComponent = (tag: string) => {
    return react.forwardRef(
      ({ children, ...props }: { children?: React.ReactNode }, ref: React.Ref<HTMLElement>) => {
        return react.createElement(tag, { ...props, ref }, children);
      }
    );
  };

  const AnimatePresence = ({ children }: { children?: React.ReactNode }) => {
    return react.createElement(react.Fragment, null, children);
  };

  return {
    motion: {
      span: createMotionComponent('span'),
      div: createMotionComponent('div'),
      p: createMotionComponent('p'),
    },
    AnimatePresence,
    useReducedMotion: () => false,
  };
});

function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('ChatWelcome', () => {
  const mockOnSend = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub();
    isMobileRef.current = false;
  });

  it('renders the chat welcome container', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('chat-welcome')).toBeInTheDocument();
  });

  it('renders a greeting heading', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('marks the greeting block as a reading surface so it renders in the serif', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    // The greeting (title + subtitle) is editorial display copy; data-reading on
    // its container flips the whole block to the serif, not just the h1.
    expect(screen.getByRole('heading', { level: 1 }).parentElement).toHaveAttribute('data-reading');
  });

  it('renders the prompt input', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('renders suggestion chips', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('suggestion-chips')).toBeInTheDocument();
  });

  it('renders Surprise Me button', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByRole('button', { name: /surprise me/i })).toBeInTheDocument();
  });

  it('calls onSend when submitting prompt', async () => {
    const user = userEvent.setup();
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Hello world');

    const sendButton = screen.getByRole('button', { name: /send/i });
    await user.click(sendButton);

    expect(mockOnSend).toHaveBeenCalledWith('Hello world', expect.any(String));
  });

  it('fills prompt input when suggestion chip is clicked', async () => {
    const user = userEvent.setup();
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    const codeChip = screen.getByRole('button', { name: /help me write code/i });
    await user.click(codeChip);

    const textarea = screen.getByRole('textbox');
    expect((textarea as HTMLTextAreaElement).value.length).toBeGreaterThan(0);
    expect(mockOnSend).not.toHaveBeenCalled();
  });

  it('has flex column layout for header and content', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    const container = screen.getByTestId('chat-welcome');
    expect(container).toHaveClass('flex');
    expect(container).toHaveClass('flex-col');
  });

  it('has dynamic viewport height and overflow-hidden to prevent scroll bar', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    const container = screen.getByTestId('chat-welcome');
    // Uses visual viewport height for mobile keyboard handling
    expect(container.style.height).toMatch(/\d+px/);
    expect(container).toHaveClass('overflow-hidden');
  });

  it('shows subtitle text', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    const page = screen.getByTestId('chat-welcome');
    expect(page.textContent).toBeTruthy();
  });

  it('renders theme toggle', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders model selector button', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('model-selector-button')).toBeInTheDocument();
  });

  it('renders ChatHeader at the top', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
  });

  it('renders privacy tagline for authenticated users', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={true} />, {
      wrapper: createWrapper(),
    });

    const tagline = screen.getByTestId('privacy-tagline');
    expect(tagline).toHaveTextContent('Encrypted storage');
    expect(tagline).toHaveTextContent('AI providers retain nothing');
  });

  it('renders privacy tagline with sign-up prompt for unauthenticated users', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    const tagline = screen.getByTestId('privacy-tagline');
    expect(tagline).toHaveTextContent('AI providers retain nothing');
    expect(tagline).toHaveTextContent('Sign up for encrypted storage');
  });

  it('renders search toggle button for authenticated users', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={true} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getAllByRole('button', { name: /internet search/i }).length).toBeGreaterThan(0);
  });

  it('renders search toggle button for unauthenticated users', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getAllByRole('button', { name: /internet search/i }).length).toBeGreaterThan(0);
  });

  it('renders ComparisonBar when multiple models are selected', () => {
    modelStoreStubRef.current.selections.text = [
      { id: 'model-1', name: 'Model One' },
      { id: 'model-2', name: 'Model Two' },
    ];

    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByTestId('selected-models-bar')).toBeInTheDocument();
  });

  it('does not render ComparisonBar when single model is selected', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.queryByTestId('selected-models-bar')).not.toBeInTheDocument();
  });

  it('uses the standard subtitle when active modality is image', () => {
    modelStoreStubRef.current.activeModality = 'image';
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.queryByText('What should we create?')).not.toBeInTheDocument();
    expect(screen.getByText('One interface. Every feature.')).toBeInTheDocument();
  });

  it('uses the standard subtitle when active modality is video', () => {
    modelStoreStubRef.current.activeModality = 'video';
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.queryByText('What scene should we make?')).not.toBeInTheDocument();
    expect(screen.getByText('One interface. Every feature.')).toBeInTheDocument();
  });

  it('uses the standard subtitle when active modality is audio', () => {
    modelStoreStubRef.current.activeModality = 'audio';
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} />, {
      wrapper: createWrapper(),
    });

    expect(screen.queryByText('What should we listen to?')).not.toBeInTheDocument();
    expect(screen.getByText('One interface. Every feature.')).toBeInTheDocument();
  });

  it('renders text-modality inspiration label by default', () => {
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={true} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByText('Need inspiration? Try these:')).toBeInTheDocument();
  });

  it('renders generic inspiration label when active modality is image', () => {
    modelStoreStubRef.current.activeModality = 'image';
    render(<ChatWelcome onSend={mockOnSend} isAuthenticated={true} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByText('Need inspiration? Try these:')).toBeInTheDocument();
  });

  describe('+Add chip integration', () => {
    it('sets picker mode to multi when the +Add chip is clicked', async () => {
      modelStoreStubRef.current.selections.text = [
        { id: 'model-1', name: 'Model One' },
        { id: 'model-2', name: 'Model Two' },
      ];
      const user = userEvent.setup();

      render(<ChatWelcome onSend={mockOnSend} isAuthenticated={true} />, {
        wrapper: createWrapper(),
      });

      await user.click(screen.getByTestId('comparison-bar-add-button'));

      expect(modelStoreStubRef.current.setPickerMode).toHaveBeenCalledWith('text', 'multi');
    });
  });

  describe('prompt input auto-focus', () => {
    it('focuses the prompt input on a warm mount that is ready immediately', () => {
      render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />, {
        wrapper: createWrapper(),
      });

      expect(screen.getByRole('textbox')).toHaveFocus();
    });

    it('focuses the prompt input after the loading-to-ready transition', () => {
      const { rerender } = render(
        <ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={true} />,
        { wrapper: createWrapper() }
      );

      rerender(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />);

      expect(screen.getByRole('textbox')).toHaveFocus();
    });

    it('does not focus the prompt input on mobile', () => {
      isMobileRef.current = true;

      render(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />, {
        wrapper: createWrapper(),
      });

      expect(screen.getByRole('textbox')).not.toHaveFocus();
    });

    it('focuses the prompt input at most once and does not steal focus on later re-renders', () => {
      const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');

      const { rerender } = render(
        <ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />,
        { wrapper: createWrapper() }
      );

      expect(focusSpy).toHaveBeenCalledTimes(1);

      rerender(<ChatWelcome onSend={mockOnSend} isAuthenticated={false} isLoading={false} />);

      expect(focusSpy).toHaveBeenCalledTimes(1);

      focusSpy.mockRestore();
    });
  });
});
