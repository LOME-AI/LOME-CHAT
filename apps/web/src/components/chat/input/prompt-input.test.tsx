import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { renderWithProviders } from '@/test-utils/render';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';

// Break the import chain that requires VITE_API_URL at module load time.
// Without these mocks, frontendEnvSchema.parse() runs in src/lib/api.ts and
// throws ZodError, preventing every test in this file from loading.
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

vi.mock('@/lib/api-client', () => ({
  client: {},
  fetchJson: vi.fn(),
}));

const { mockUseModels } = vi.hoisted(() => ({
  mockUseModels: vi.fn(() => ({ data: { models: [], premiumIds: new Set<string>() } })),
}));
vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };
function resetModelStoreStub(overrides: Partial<ModelStoreStub> = {}): void {
  modelStoreStubRef.current = createModelStoreStub(overrides);
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

const useReducedMotionMock = vi.fn<() => boolean>();
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useReducedMotion: (): boolean => useReducedMotionMock(),
  };
});

import { PromptInput } from '@/components/chat/input/prompt-input';
import type { ChatSearchProps, PromptInputRef } from '@/components/chat/input/prompt-input';
import type { PromptBudgetResult } from '@/hooks/billing/use-prompt-budget';

// Mock usePromptBudget directly — PromptInput's only budget dependency
const mockUsePromptBudget = vi.fn();

vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: (...args: unknown[]) => mockUsePromptBudget(...args),
}));

const defaultStabilityState = {
  isAuthStable: true,
  isBalanceStable: true,
  isAppStable: true,
};
const mockUseStability = vi.fn(() => defaultStabilityState);

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => mockUseStability(),
  StabilityProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/shared/stable-content', () => ({
  StableContent: ({ isStable, children }: { isStable: boolean; children: React.ReactNode }) =>
    isStable ? children : null,
}));

const defaultBudget: PromptBudgetResult = {
  fundingSource: 'personal_balance',
  notifications: [],
  capacityPercent: 5,
  capacityCurrentUsage: 1100,
  capacityMaxCapacity: 50_000,
  estimatedCostCents: 0.1,
  isOverCapacity: false,
  hasBlockingError: false,
  hasContent: true,
};

/**
 * Build a `searchProps` fixture for PromptInput tests. Defaults:
 * webSearchEnabled=false, onToggleWebSearch=vi.fn(). Override any field as needed.
 */
function makeSearchProps(overrides: Partial<ChatSearchProps> = {}): ChatSearchProps {
  return {
    webSearchEnabled: false,
    canUseWebSearch: true,
    onToggleWebSearch: vi.fn(),
    ...overrides,
  };
}

describe('PromptInput', () => {
  const mockOnChange = vi.fn();
  const mockOnSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockUsePromptBudget.mockImplementation((input: { value: string }) => ({
      ...defaultBudget,
      hasContent: input.value.trim().length > 0,
    }));
    mockUseStability.mockReturnValue(defaultStabilityState);
    useReducedMotionMock.mockReturnValue(false);
    resetModelStoreStub();
    mockUseModels.mockReturnValue({
      data: { models: [], premiumIds: new Set<string>() },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a textarea', () => {
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  describe('animated placeholder overlay', () => {
    it('renders the AnimatedPlaceholder with the given placeholder text when value is empty', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Ask me anything..."
        />
      );
      const overlay = screen.getByTestId('animated-placeholder');
      expect(overlay).toBeInTheDocument();
      expect(overlay).toHaveTextContent('Ask me anything...');
    });

    it('does not render the AnimatedPlaceholder while the textarea has content (no-op when typing)', () => {
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Ask me anything..."
        />
      );
      expect(screen.queryByTestId('animated-placeholder')).not.toBeInTheDocument();
    });

    it('does not set a native placeholder attribute (the overlay drives the visual)', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Ask me anything..."
        />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea.getAttribute('placeholder') ?? '').toBe('');
    });

    it('keeps aria-label on the textarea so the placeholder is still the accessible name', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Ask me anything..."
        />
      );
      expect(screen.getByRole('textbox')).toHaveAttribute('aria-label', 'Ask me anything...');
    });

    it('updates the overlay text when the placeholder prop changes (modality switch)', () => {
      const { rerender } = renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Ask me anything..."
        />
      );
      expect(screen.getByTestId('animated-placeholder')).toHaveTextContent('Ask me anything...');

      rerender(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          placeholder="Describe the image you want..."
        />
      );
      expect(screen.getByTestId('animated-placeholder')).toHaveTextContent(
        'Describe the image you want...'
      );
    });
  });

  it('displays the current value', () => {
    renderWithProviders(
      <PromptInput value="Hello world" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    expect(screen.getByRole('textbox')).toHaveValue('Hello world');
  });

  it('calls onChange when typing', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'Test');
    expect(mockOnChange).toHaveBeenCalled();
  });

  it('calls onSubmit when Enter is pressed without Shift', () => {
    renderWithProviders(
      <PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(mockOnSubmit).toHaveBeenCalled();
  });

  it('does not call onSubmit when Shift+Enter is pressed (allows newline)', () => {
    renderWithProviders(
      <PromptInput value="Test message" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(mockOnSubmit).not.toHaveBeenCalled();
  });

  it('has send button', () => {
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('send button calls onSubmit when clicked', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderWithProviders(
      <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} />
    );
    const sendButton = screen.getByRole('button', { name: /send/i });
    await user.click(sendButton);
    expect(mockOnSubmit).toHaveBeenCalled();
  });

  it('send button is disabled when value is empty', () => {
    renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  describe('capacity bar', () => {
    it('displays capacity bar', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
    });

    it('shows capacity percentage', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        capacityPercent: 25,
        capacityCurrentUsage: 12_500,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByText(/Model \d+% filled/)).toBeInTheDocument();
    });

    it('send button is disabled when over capacity', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        capacityPercent: 105,
        isOverCapacity: true,
        hasBlockingError: true,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('send button is disabled when billing is denied', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          { id: 'insufficient_balance', type: 'error', message: 'Insufficient balance.' },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('textarea remains enabled even when over capacity', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        capacityPercent: 105,
        isOverCapacity: true,
        hasBlockingError: true,
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('textbox')).not.toBeDisabled();
    });
  });

  describe('budget messages', () => {
    it('displays budget notifications when present', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          { id: 'insufficient_balance', type: 'error', message: 'Insufficient balance.' },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByTestId('budget-messages')).toBeInTheDocument();
      expect(screen.getByText('Insufficient balance.')).toBeInTheDocument();
    });

    it('does not show budget messages when no notifications', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
    });

    it('shows warning messages', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'capacity_warning',
            type: 'warning',
            message: "Your conversation is near this model's memory limit.",
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(
        screen.getByText("Your conversation is near this model's memory limit.")
      ).toBeInTheDocument();
    });

    it('shows info messages', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'trial_notice',
            type: 'info',
            message: 'Free preview. Sign up for full access.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByText('Free preview. Sign up for full access.')).toBeInTheDocument();
    });

    it('hides budget messages while app is not stable (balance loading)', () => {
      mockUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: false,
        isAppStable: false,
      });
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'trial_notice',
            type: 'info',
            message: 'Free preview. Sign up for full access.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
      expect(screen.queryByText('Free preview. Sign up for full access.')).not.toBeInTheDocument();
    });

    it('hides budget messages while app is not stable (session loading)', () => {
      mockUseStability.mockReturnValue({
        isAuthStable: false,
        isBalanceStable: true,
        isAppStable: false,
      });
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        notifications: [
          {
            id: 'trial_notice',
            type: 'info',
            message: 'Free preview. Sign up for full access.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByTestId('budget-messages')).not.toBeInTheDocument();
      expect(screen.queryByText('Free preview. Sign up for full access.')).not.toBeInTheDocument();
    });
  });

  describe('self-contained budget calculation', () => {
    it('accepts historyCharacters prop for budget calculation', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          historyCharacters={5000}
        />
      );
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
    });

    it('accepts capabilities prop for system prompt calculation', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          capabilities={['vision']}
        />
      );
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
    });
  });

  describe('custom height props', () => {
    it('applies custom minHeight when provided', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} minHeight="56px" />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveStyle({ minHeight: '56px' });
    });

    it('applies custom maxHeight when provided', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} maxHeight="112px" />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveStyle({ maxHeight: '112px' });
    });

    it('uses default minHeight when not provided', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveStyle({ minHeight: '120px' });
    });

    it('uses default maxHeight when not provided', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveStyle({ maxHeight: '40vh' });
    });

    it('flows an arbitrary minHeight value through to the applied style', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} minHeight="999px" />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveStyle({ minHeight: '999px' });
    });

    it('flows an arbitrary maxHeight value through to the applied style', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} maxHeight="80vh" />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveStyle({ maxHeight: '80vh' });
    });

    it('does not emit runtime-interpolated arbitrary Tailwind height classes', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          minHeight="56px"
          maxHeight="112px"
        />
      );
      const textarea = screen.getByRole('textbox');
      expect(textarea.className).not.toMatch(/min-h-\[/);
      expect(textarea.className).not.toMatch(/max-h-\[/);
    });
  });

  describe('processing mode', () => {
    it('disables the send button during processing when no queue handler is provided', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} isProcessing />
      );
      const button = screen.getByRole('button', { name: /cannot send/i });
      expect(button).toBeDisabled();
    });

    it('never renders the stop/square icon during processing; keeps the send icon', () => {
      const { container } = renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} isProcessing />
      );
      const button = screen.getByTestId('send-button');
      expect(button.querySelector('.lucide-square')).toBeNull();
      expect(container.querySelector('.lucide-square')).toBeNull();
      expect(button.querySelector('.lucide-send')).toBeInTheDocument();
    });

    it('renders the send icon (never a stop icon) when idle', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      const button = screen.getByTestId('send-button');
      expect(button.querySelector('.lucide-square')).toBeNull();
      expect(button.querySelector('.lucide-send')).toBeInTheDocument();
    });

    it('keeps textarea enabled during processing for type-ahead', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} isProcessing />
      );
      expect(screen.getByRole('textbox')).not.toBeDisabled();
    });

    it('shows send icon when not processing and can submit', () => {
      renderWithProviders(
        <PromptInput value="Test" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      const button = screen.getByRole('button', { name: /send/i });
      expect(button).not.toBeDisabled();
    });
  });

  describe('queue while streaming', () => {
    it('click enqueues the trimmed text and clears the input, not calling onSubmit', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="  hello  "
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      const button = screen.getByTestId('send-button');
      expect(button).not.toBeDisabled();
      fireEvent.click(button);
      expect(onQueue).toHaveBeenCalledWith('hello');
      expect(mockOnChange).toHaveBeenCalledWith('');
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('Enter enqueues the trimmed text and clears the input, not calling onSubmit', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="  hello  "
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(onQueue).toHaveBeenCalledWith('hello');
      expect(mockOnChange).toHaveBeenCalledWith('');
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('disables the button and shows a queue-full hint when the queue is full', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
          queueFull
          queueCount={5}
        />
      );
      expect(screen.getByTestId('send-button')).toBeDisabled();
      const hint = screen.getByTestId('queue-full-hint');
      expect(hint).toHaveTextContent('Queue full (5)');
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(onQueue).not.toHaveBeenCalled();
    });

    it('disables the queue button for whitespace-only input during streaming', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="   "
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      expect(screen.getByTestId('send-button')).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      expect(onQueue).not.toHaveBeenCalled();
    });

    it('does not render the queue-full hint when the queue is not full', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isProcessing
          onQueue={onQueue}
        />
      );
      expect(screen.queryByTestId('queue-full-hint')).not.toBeInTheDocument();
    });

    it('sends normally (not queue) when idle even if onQueue is supplied', () => {
      const onQueue = vi.fn();
      renderWithProviders(
        <PromptInput
          value="hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onQueue={onQueue}
        />
      );
      fireEvent.click(screen.getByTestId('send-button'));
      expect(mockOnSubmit).toHaveBeenCalled();
      expect(onQueue).not.toHaveBeenCalled();
    });
  });

  describe('ref and focus', () => {
    it('exposes focus method via ref', () => {
      const ref = React.createRef<PromptInputRef>();
      renderWithProviders(
        <PromptInput ref={ref} value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      expect(ref.current).not.toBeNull();
      expect(typeof ref.current?.focus).toBe('function');
    });

    it('focuses textarea when focus() is called', () => {
      const ref = React.createRef<PromptInputRef>();
      renderWithProviders(
        <PromptInput ref={ref} value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);

      ref.current?.focus();

      expect(document.activeElement).toBe(textarea);
    });

    it('does not auto-focus when initially enabled (not a transition)', () => {
      renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled={false} />
      );

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);
    });

    it('does not auto-focus when transitioning from enabled to disabled', () => {
      const { rerender } = renderWithProviders(
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled={false} />
      );

      const textarea = screen.getByRole('textbox');

      rerender(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled />);

      expect(textarea).toBeDisabled();
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  describe('autoFocus prop', () => {
    it('applies autoFocus to textarea when autoFocus is true', async () => {
      renderWithProviders(
        // eslint-disable-next-line jsx-a11y/no-autofocus -- test exercises autoFocus prop behavior
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} autoFocus />
      );

      const textarea = screen.getByRole('textbox');
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(textarea);
      });
    });

    it('does not autoFocus textarea when autoFocus is false', () => {
      renderWithProviders(
        // eslint-disable-next-line jsx-a11y/no-autofocus -- test exercises autoFocus prop behavior
        <PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} autoFocus={false} />
      );

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);
    });

    it('does not autoFocus textarea when autoFocus is not provided', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);

      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);
    });
  });

  describe('AI toggle', () => {
    it('does not show AI toggle when isGroupChat is not set', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByRole('button', { name: /AI response/i })).not.toBeInTheDocument();
    });

    it('shows AI toggle when isGroupChat is true', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      expect(screen.getByRole('button', { name: /AI response on/i })).toBeInTheDocument();
    });

    it('defaults to AI ON', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      expect(screen.getByRole('button', { name: /AI response on/i })).toBeInTheDocument();
    });

    it('toggles to AI OFF when clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      const toggle = screen.getByRole('button', { name: /AI response on/i });
      await user.click(toggle);
      expect(screen.getByRole('button', { name: /AI response off/i })).toBeInTheDocument();
    });

    it('toggles back to AI ON on second click', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );
      const toggle = screen.getByRole('button', { name: /AI response on/i });
      await user.click(toggle);
      await user.click(screen.getByRole('button', { name: /AI response off/i }));
      expect(screen.getByRole('button', { name: /AI response on/i })).toBeInTheDocument();
    });

    it('calls onSubmitUserOnly instead of onSubmit when AI is off', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );
      await user.click(screen.getByRole('button', { name: /AI response on/i }));
      await user.click(screen.getByRole('button', { name: /send/i }));
      expect(mockSubmitUserOnly).toHaveBeenCalled();
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('calls onSubmit when AI is on (default)', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );
      await user.click(screen.getByRole('button', { name: /send/i }));
      expect(mockOnSubmit).toHaveBeenCalled();
      expect(mockSubmitUserOnly).not.toHaveBeenCalled();
    });

    it('calls onSubmitUserOnly on Enter key when AI is off', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockSubmitUserOnly = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onSubmitUserOnly={mockSubmitUserOnly}
          isGroupChat
        />
      );
      await user.click(screen.getByRole('button', { name: /AI response on/i }));
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockSubmitUserOnly).toHaveBeenCalled();
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe('onTypingChange', () => {
    it('calls onTypingChange with true on first input change', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'H' } });
      expect(mockOnTypingChange).toHaveBeenCalledWith(true);
    });

    it('calls onTypingChange with false on submit', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockOnTypingChange).toHaveBeenCalledWith(false);
    });

    it('throttles onTypingChange calls within 3s window', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');

      fireEvent.change(textarea, { target: { value: 'H' } });
      expect(mockOnTypingChange).toHaveBeenCalledTimes(1);

      fireEvent.change(textarea, { target: { value: 'He' } });
      expect(mockOnTypingChange).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(3000);
      fireEvent.change(textarea, { target: { value: 'Hel' } });
      expect(mockOnTypingChange).toHaveBeenCalledTimes(2);
    });

    it('calls onTypingChange with false when value becomes empty', () => {
      const mockOnTypingChange = vi.fn();
      renderWithProviders(
        <PromptInput
          value="H"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );
      const textarea = screen.getByRole('textbox');

      fireEvent.change(textarea, { target: { value: '' } });
      expect(mockOnTypingChange).toHaveBeenCalledWith(false);
    });

    it('calls onTypingChange with false on unmount', () => {
      const mockOnTypingChange = vi.fn();
      const { unmount } = renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          onTypingChange={mockOnTypingChange}
        />
      );

      mockOnTypingChange.mockClear();
      unmount();
      expect(mockOnTypingChange).toHaveBeenCalledWith(false);
    });

    it('does not error when onTypingChange is not provided', () => {
      renderWithProviders(<PromptInput value="" onChange={mockOnChange} onSubmit={mockOnSubmit} />);
      const textarea = screen.getByRole('textbox');
      expect(() => {
        fireEvent.change(textarea, { target: { value: 'H' } });
      }).not.toThrow();
    });
  });

  describe('search toggle', () => {
    it('does not show search toggle by default', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByRole('button', { name: /internet search/i })).not.toBeInTheDocument();
    });

    it('shows enabled search toggle when model supports search and user is authenticated', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps()}
        />
      );
      expect(screen.getByRole('button', { name: /turn on internet search/i })).toBeInTheDocument();
    });

    it('shows search on state when webSearchEnabled is true', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );
      expect(screen.getByRole('button', { name: /turn off internet search/i })).toBeInTheDocument();
    });

    it('renders the off state with a crossed-out, dimmed icon', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps()}
        />
      );
      const button = screen.getByRole('button', { name: /turn on internet search/i });
      const icon = button.querySelector('svg');
      expect(icon).not.toBeNull();
      expect(icon).toHaveClass('lucide-search-x');
      expect(icon).toHaveClass('opacity-50');
    });

    it('renders the on state with the plain search icon at full opacity', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );
      const button = screen.getByRole('button', { name: /turn off internet search/i });
      const icon = button.querySelector('svg');
      expect(icon).not.toBeNull();
      expect(icon).toHaveClass('lucide-search');
      expect(icon).not.toHaveClass('lucide-search-x');
      expect(icon).not.toHaveClass('opacity-50');
    });

    it('calls onToggleWebSearch when clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const mockToggle = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ onToggleWebSearch: mockToggle })}
        />
      );
      await user.click(screen.getByRole('button', { name: /turn on internet search/i }));
      expect(mockToggle).toHaveBeenCalled();
    });

    it('shows disabled search toggle for unauthenticated users', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          searchProps={makeSearchProps({ canUseWebSearch: false })}
        />
      );
      const wrapper = screen.getByRole('button', { name: /internet search unavailable/i });
      expect(wrapper).toHaveAttribute('aria-disabled', 'true');
    });

    it('does not render the search toggle when activeModality is image (searchProps undefined)', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="image"
        />
      );
      // Structural guard: chat-layout omits searchProps in image mode, so the
      // toggle should not be rendered at all (not just disabled).
      expect(screen.queryByRole('button', { name: /internet search/i })).not.toBeInTheDocument();
    });

    it('does not render the search toggle when activeModality is video (searchProps undefined)', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="video"
        />
      );
      expect(screen.queryByRole('button', { name: /internet search/i })).not.toBeInTheDocument();
    });
  });

  describe('toggle button tooltips', () => {
    it('wraps disabled search toggle in span for tooltip accessibility', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          searchProps={makeSearchProps({ canUseWebSearch: false })}
        />
      );

      // The role=button entry is the wrapper span itself (inner native button
      // is aria-hidden when disabled). Confirm it is the tooltip trigger span.
      const wrapper = screen.getByRole('button', { name: /internet search unavailable/i });
      expect(wrapper.tagName).toBe('SPAN');
      expect(wrapper).toHaveAttribute('data-slot', 'tooltip-trigger');
    });

    it('wraps enabled search toggle in span for tooltip consistency', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );

      const button = screen.getByRole('button', { name: /turn off internet search/i });
      const wrapper = button.closest('span[data-slot="tooltip-trigger"]');
      expect(wrapper).not.toBeNull();
    });

    it('wraps AI toggle in span for tooltip consistency', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );

      const button = screen.getByRole('button', { name: /AI response on/i });
      const wrapper = button.closest('span[data-slot="tooltip-trigger"]');
      expect(wrapper).not.toBeNull();
    });

    it('shows tooltip content when hovering search toggle', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ webSearchEnabled: true })}
        />
      );

      const button = screen.getByRole('button', { name: /turn off internet search/i });
      await user.hover(button);

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('Turn off internet search');
    });

    it('shows tooltip content when hovering AI toggle', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} isGroupChat />
      );

      const button = screen.getByRole('button', { name: /AI response on/i });
      await user.hover(button);

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('AI response on');
    });

    it('updates search toggle tooltip text after state change', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();

      function SearchToggleHarness(): React.JSX.Element {
        const [searchOn, setSearchOn] = React.useState(false);
        return (
          <PromptInput
            value="Hello"
            onChange={mockOnChange}
            onSubmit={mockOnSubmit}
            isAuthenticated
            searchProps={makeSearchProps({
              webSearchEnabled: searchOn,
              onToggleWebSearch: () => {
                setSearchOn((previous) => !previous);
              },
            })}
          />
        );
      }

      renderWithProviders(<SearchToggleHarness />);

      const button = screen.getByRole('button', { name: /turn on internet search/i });
      await user.hover(button);

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('Turn on internet search');

      await user.click(button);

      expect(screen.getByRole('button', { name: /turn off internet search/i })).toBeInTheDocument();
      const updatedTooltip = screen.getByRole('tooltip');
      expect(updatedTooltip).toHaveTextContent('Turn off internet search');
    });
  });

  describe('edit mode', () => {
    it('shows editing indicator when isEditing is true', () => {
      renderWithProviders(
        <PromptInput
          value="Edited content"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={vi.fn()}
        />
      );
      expect(screen.getByText(/editing/i)).toBeInTheDocument();
    });

    it('does not show editing indicator when isEditing is false', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByText(/editing/i)).not.toBeInTheDocument();
    });

    it('shows cancel button in edit mode', () => {
      renderWithProviders(
        <PromptInput
          value="Edited content"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('calls onCancelEdit when cancel button is clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const onCancelEdit = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Edited content"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={onCancelEdit}
        />
      );
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onCancelEdit).toHaveBeenCalledTimes(1);
    });

    it('does not show cancel button when not editing', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });
  });

  describe('privilege and conversationId forwarding to usePromptBudget', () => {
    it('passes currentUserPrivilege to usePromptBudget even without conversationId', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'read_only_notice',
            type: 'info',
            message: 'You have read-only access to this conversation.',
          },
        ],
      });

      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );

      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          currentUserPrivilege: 'read',
        })
      );
    });

    it('passes both conversationId and currentUserPrivilege to usePromptBudget', () => {
      mockUsePromptBudget.mockReturnValue(defaultBudget);

      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          conversationId="conv-123"
          currentUserPrivilege="write"
        />
      );

      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-123',
          currentUserPrivilege: 'write',
        })
      );
    });

    it('passes conversationId without currentUserPrivilege to usePromptBudget', () => {
      mockUsePromptBudget.mockReturnValue(defaultBudget);

      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          conversationId="conv-123"
        />
      );

      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-123',
        })
      );
      expect(mockUsePromptBudget).toHaveBeenCalledWith(
        expect.not.objectContaining({
          currentUserPrivilege: expect.anything(),
        })
      );
    });
  });

  describe('read-only privilege', () => {
    it('send button is disabled when currentUserPrivilege is read', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'read_only_notice',
            type: 'info',
            message: 'You have read-only access to this conversation.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('read-only notification renders when currentUserPrivilege is read', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'read_only_notice',
            type: 'info',
            message: 'You have read-only access to this conversation.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );
      expect(
        screen.getByText('You have read-only access to this conversation.')
      ).toBeInTheDocument();
    });

    it('Enter key does not submit when currentUserPrivilege is read', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        fundingSource: 'denied',
        hasBlockingError: true,
        notifications: [
          {
            id: 'read_only_notice',
            type: 'info',
            message: 'You have read-only access to this conversation.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          currentUserPrivilege="read"
        />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe('blocking errors', () => {
    it('send button is disabled when blocking error present', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        notifications: [
          {
            id: 'capacity_exceeded',
            type: 'error',
            message: 'Message exceeds model capacity.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('Enter key does not submit when blocking error present', () => {
      mockUsePromptBudget.mockReturnValue({
        ...defaultBudget,
        hasBlockingError: true,
        notifications: [
          {
            id: 'capacity_exceeded',
            type: 'error',
            message: 'Message exceeds model capacity.',
          },
        ],
      });
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });

  describe('modality icons', () => {
    it('does not render any modality icons when isAuthenticated is undefined', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      expect(
        screen.queryByRole('button', { name: /switch to (image|video|audio|text)/i })
      ).not.toBeInTheDocument();
    });

    it('renders modality icons disabled with sign-up label for unauthenticated users', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      // Disabled state: wrapping span owns role=button with aria-disabled=true,
      // inner native button is aria-hidden so the same name isn't announced
      // twice. Assert the wrappers communicate disabled via aria-disabled.
      const wrappers = screen.getAllByRole('button', { name: /sign up to unlock/i });
      expect(wrappers.length).toBeGreaterThan(0);
      for (const wrapper of wrappers) {
        expect(wrapper).toHaveAttribute('aria-disabled', 'true');
      }
    });

    it('makes disabled trial modality icons keyboard-focusable for tooltip discovery', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      // The wrapping span carries role=button + tabIndex=0 so keyboard users
      // can tab onto it and read the trial tooltip (the inner native button is
      // disabled and unreachable). aria-disabled communicates "not actionable".
      const wrappers = screen
        .getAllByRole('button', { name: /sign up to unlock/i })
        .filter((element) => element.tagName !== 'BUTTON');
      expect(wrappers.length).toBeGreaterThan(0);
      for (const wrapper of wrappers) {
        expect(wrapper).toHaveAttribute('tabindex', '0');
        expect(wrapper).toHaveAttribute('aria-disabled', 'true');
      }
    });

    it('uses per-modality trial tooltip text mentioning the modality name', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      // The image and video icons render with action-context tooltips.
      expect(
        screen.queryAllByRole('button', {
          name: /image generation — sign up to unlock/i,
        }).length
      ).toBeGreaterThan(0);
      expect(
        screen.queryAllByRole('button', {
          name: /video generation — sign up to unlock/i,
        }).length
      ).toBeGreaterThan(0);
    });

    it('disabled trial modality icon exposes exactly one accessible button per modality', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      // Wrapper span owns the role+name when disabled; inner native button is
      // aria-hidden so the same accessible name isn't announced twice. Assertion
      // is one role=button per modality, not two.
      expect(
        screen.queryAllByRole('button', {
          name: /image generation — sign up to unlock/i,
        })
      ).toHaveLength(1);
      expect(
        screen.queryAllByRole('button', {
          name: /video generation — sign up to unlock/i,
        })
      ).toHaveLength(1);
    });

    it('does not invoke onSelectModality when a disabled trial icon is clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const handleSelect = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated={false}
          activeModality="text"
          onSelectModality={handleSelect}
        />
      );
      const button = screen.getAllByRole('button', { name: /sign up to unlock/i })[0];
      if (!button) throw new Error('Expected at least one disabled trial icon');
      await user.click(button);
      expect(handleSelect).not.toHaveBeenCalled();
    });

    it('renders image and video icons for authenticated users in text mode', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: /switch to image/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /switch to video/i })).toBeInTheDocument();
      // Active modality (text) has no icon
      expect(screen.queryByRole('button', { name: /switch to text/i })).not.toBeInTheDocument();
    });

    it('renders text and video icons for authenticated users in image mode', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="image"
          onSelectModality={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: /switch to text/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /switch to video/i })).toBeInTheDocument();
      // Active modality (image) has no icon
      expect(screen.queryByRole('button', { name: /switch to image/i })).not.toBeInTheDocument();
    });

    it('renders text and image icons for authenticated users in video mode', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="video"
          onSelectModality={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: /switch to text/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /switch to image/i })).toBeInTheDocument();
      // Active modality (video) has no icon
      expect(screen.queryByRole('button', { name: /switch to video/i })).not.toBeInTheDocument();
    });

    it('does not render an audio icon while the feature flag is off', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      expect(screen.queryByRole('button', { name: /switch to audio/i })).not.toBeInTheDocument();
    });

    it('invokes onSelectModality with the target modality when an icon is clicked', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      const handleSelect = vi.fn();
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={handleSelect}
        />
      );
      await user.click(screen.getByRole('button', { name: /switch to video/i }));
      expect(handleSelect).toHaveBeenCalledWith('video');
    });
  });

  describe('toolbar order', () => {
    it('renders search toggle before the modality icons in text mode (left-aligned cluster)', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
          searchProps={makeSearchProps()}
        />
      );
      const search = screen.getByRole('button', { name: /turn on internet search/i });
      const imageIcon = screen.getByRole('button', { name: /switch to image/i });
      // DOM order: search element should precede the image modality icon.
      const position = search.compareDocumentPosition(imageIcon);
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('bottom row layouts per modality', () => {
    it('renders text modality with capacity bar and no modality config controls above textarea', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
      // No aspect ratio chips in text mode.
      expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument();
    });

    it('renders image modality bottom-row with aspect ratio chips and no capacity bar', () => {
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [],
          image: [{ id: 'google/imagen-4', name: 'Imagen 4' }],
          audio: [],
          video: [],
        },
      });
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'google/imagen-4',
              modality: 'image',
              pricing: { perImage: '40000000' },
            } as never,
          ],
          premiumIds: new Set<string>(),
        },
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="image"
          onSelectModality={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
      expect(screen.queryByTestId('capacity-bar')).not.toBeInTheDocument();
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });

    it('renders video modality with duration in row 1 and aspect ratio + resolution in row 2', () => {
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
        selections: {
          text: [],
          image: [],
          audio: [],
          video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
        },
      });
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'google/veo-3.1',
              modality: 'video',
              pricing: { perSecondByResolution: { '720p': '100000000', '1080p': '150000000' } },
            } as never,
          ],
          premiumIds: new Set<string>(),
        },
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="video"
          onSelectModality={vi.fn()}
        />
      );
      // Row 1: duration slider + cost
      expect(screen.getByRole('slider', { name: /video duration/i })).toBeInTheDocument();
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
      // Row 2: aspect ratio + resolution
      expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /720p/i })).toBeInTheDocument();
      // No capacity bar in video mode.
      expect(screen.queryByTestId('capacity-bar')).not.toBeInTheDocument();
    });

    it('renders audio modality bottom-row when FEATURE_FLAGS.AUDIO_ENABLED is on', async () => {
      const { FEATURE_FLAGS } = await import('@hushbox/shared');
      const original = FEATURE_FLAGS.AUDIO_ENABLED;
      FEATURE_FLAGS.AUDIO_ENABLED = true;
      try {
        resetModelStoreStub({
          activeModality: 'audio',
          audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
          selections: {
            text: [],
            image: [],
            audio: [{ id: 'openai/tts-1', name: 'TTS-1' }],
            video: [],
          },
        });
        mockUseModels.mockReturnValue({
          data: {
            models: [{ id: 'openai/tts-1', modality: 'audio', pricing: {} } as never],
            premiumIds: new Set<string>(),
          },
        });
        renderWithProviders(
          <PromptInput
            value="Hello"
            onChange={mockOnChange}
            onSubmit={mockOnSubmit}
            isAuthenticated
            activeModality="audio"
            onSelectModality={vi.fn()}
          />
        );
        expect(screen.getByRole('button', { name: 'mp3' })).toBeInTheDocument();
        expect(screen.getByRole('slider', { name: /audio max duration/i })).toBeInTheDocument();
      } finally {
        FEATURE_FLAGS.AUDIO_ENABLED = original;
      }
    });

    it('does not render audio controls when FEATURE_FLAGS.AUDIO_ENABLED is off', () => {
      // Default flag state is off — no audio controls should render even with
      // audio modality set in the store.
      resetModelStoreStub({
        activeModality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
      });
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="audio"
          onSelectModality={vi.fn()}
        />
      );
      expect(screen.queryByRole('button', { name: 'mp3' })).not.toBeInTheDocument();
      expect(screen.queryByRole('slider', { name: /audio max duration/i })).not.toBeInTheDocument();
    });
  });

  describe('toolbar / send button spacing', () => {
    it('separates the toolbar cluster from the send button with gap-2', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      const sendButton = screen.getByTestId('send-button');
      const outerCluster = sendButton.parentElement;
      expect(outerCluster).not.toBeNull();
      expect(outerCluster!.className).toMatch(/\bgap-2\b/);
    });

    it('keeps the inner toolbar gap at gap-1', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
          isGroupChat
        />
      );
      const aiButton = screen.getByRole('button', { name: /AI response on/i });
      // Walk up to find the toolbar container (the one that holds modality
      // icons, search, AI). It must use gap-1 to keep icons visually tight.
      let element: HTMLElement | null = aiButton.parentElement;
      let toolbar: HTMLElement | null = null;
      while (element) {
        if (element.className.includes('gap-1') && !element.className.includes('gap-1.5')) {
          toolbar = element;
          break;
        }
        element = element.parentElement;
      }
      expect(toolbar).not.toBeNull();
    });
  });

  describe('modality switch animation', () => {
    it('wraps bottom-row content in a height-animation wrapper', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          activeModality="text"
          onSelectModality={vi.fn()}
        />
      );
      const sendButton = screen.getByTestId('send-button');
      // AnimatedHeight always renders the wrapper now — MotionConfig at the
      // root collapses the animation to instant under reduced motion.
      const motionWrapper = sendButton.closest('.overflow-y-hidden');
      expect(motionWrapper).not.toBeNull();
    });
  });

  describe('edit banner animation', () => {
    it('renders the edit banner inside the height-animation wrapper', () => {
      renderWithProviders(
        <PromptInput
          value="Hello"
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isEditing
          onCancelEdit={vi.fn()}
        />
      );
      const banner = screen.getByText(/editing/i);
      // Edit banner uses AnimatedHeight (`overflow-hidden`), not MorphHeight
      // (`overflow-y-hidden`); the bottom-row test above checks MorphHeight.
      const motionWrapper = banner.closest('.overflow-hidden');
      expect(motionWrapper).not.toBeNull();
    });
  });

  describe('submit guards and disabled tooltips', () => {
    it('keeps the send button disabled when there is content but the input is disabled', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled />
      );

      expect(screen.getByTestId('send-button')).toBeDisabled();
    });

    it('opens and closes the tooltip on focus and blur of a disabled search toggle', () => {
      renderWithProviders(
        <PromptInput
          value=""
          onChange={mockOnChange}
          onSubmit={mockOnSubmit}
          isAuthenticated
          searchProps={makeSearchProps({ canUseWebSearch: false })}
        />
      );

      const wrapper = screen.getByRole('button', { name: 'Internet search unavailable' });

      fireEvent.focus(wrapper);
      fireEvent.blur(wrapper);

      expect(wrapper).toHaveAttribute('aria-disabled', 'true');
    });

    it('does not submit on Enter when the input cannot submit', () => {
      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} disabled />
      );

      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('does not submit when funding is denied even if the send button is clicked', () => {
      mockUsePromptBudget.mockImplementation((input: { value: string }) => ({
        ...defaultBudget,
        fundingSource: 'denied',
        hasContent: input.value.trim().length > 0,
      }));

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      fireEvent.click(screen.getByTestId('send-button'));

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it('does not submit on Enter when funding is denied', () => {
      mockUsePromptBudget.mockImplementation((input: { value: string }) => ({
        ...defaultBudget,
        fundingSource: 'denied',
        hasContent: input.value.trim().length > 0,
      }));

      renderWithProviders(
        <PromptInput value="Hello" onChange={mockOnChange} onSubmit={mockOnSubmit} />
      );

      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });
  });
});
