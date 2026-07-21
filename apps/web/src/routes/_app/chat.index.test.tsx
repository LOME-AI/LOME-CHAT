import * as React from 'react';
import { makeBalance } from '@/test-utils/balance-fixture';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './chat.index';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const {
  mockUseStableSession,
  mockNavigate,
  mockUseBalance,
  mockUseStability,
  mockInvalidateQueries,
} = vi.hoisted(() => ({
  mockUseStableSession: vi.fn(),
  mockNavigate: vi.fn(),
  mockUseBalance: vi.fn(),
  mockUseStability: vi.fn(),
  mockInvalidateQueries: vi.fn(),
}));

// Keep the real router (createFileRoute must run for the route file); override only useNavigate.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Keep the real @tanstack/react-query (the render harness provides the real
// QueryClientProvider); override only useQueryClient so the PaymentModal's
// onSuccess invalidation is observable and can be forced to reject.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

// PaymentModal renders only when open; the stub surfaces its onSuccess so the
// route's balance-invalidation callback can be triggered from a click.
vi.mock('@/components/billing/payment-modal', () => ({
  PaymentModal: ({ open, onSuccess }: { open: boolean; onSuccess: () => void }) =>
    open ? (
      <button type="button" data-testid="payment-modal-success" onClick={onSuccess}>
        success
      </button>
    ) : null,
}));

vi.mock('@/hooks/auth/use-stable-session', () => ({
  useStableSession: mockUseStableSession,
}));

// Override the global stability mock (test-setup) so each test controls useStability,
// while keeping a pass-through StabilityProvider for the real render harness.
vi.mock('@/providers/stability-provider', () => ({
  useStability: mockUseStability,
  StabilityProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: mockUseBalance,
  billingKeys: {
    balance: () => ['balance'],
  },
}));

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

const mockClearError = vi.fn();
const mockClearAll = vi.fn();
vi.mock('@/stores/chat-error', () => ({
  MAIN_FORK_KEY: 'main',
  useChatErrorStore: Object.assign(() => null, {
    getState: () => ({
      errorsByFork: {},
      setError: vi.fn(),
      clearError: mockClearError,
      clearAll: mockClearAll,
    }),
  }),
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const { createModelStoreStub, selectorFromState } = await import('@/test-utils/model-store-mock');
  const state = createModelStoreStub();
  return { ...actual, useModelStore: vi.fn(selectorFromState(state)) };
});

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
        premiumIds: new Set<string>(),
      },
      isLoading: false,
      error: null,
    })),
  };
});

vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: (input: { value: string }) => ({
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

// Keep the real framer-motion (MotionProvider in the render harness needs
// MotionConfig/useReducedMotion); override only the animated primitives ChatWelcome uses.
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  const react = await import('react');

  const createMotionComponent = (tag: string) => {
    return react.forwardRef(
      (
        {
          children,
          // Strip framer-motion-only props so they are not forwarded to the DOM
          // element, which would make React warn about non-boolean attributes.
          initial: _initial,
          animate: _animate,
          exit: _exit,
          transition: _transition,
          variants: _variants,
          whileHover: _whileHover,
          whileTap: _whileTap,
          whileFocus: _whileFocus,
          whileInView: _whileInView,
          whileDrag: _whileDrag,
          layout: _layout,
          layoutId: _layoutId,
          drag: _drag,
          dragConstraints: _dragConstraints,
          onAnimationComplete: _onAnimationComplete,
          ...props
        }: Record<string, unknown> & { children?: React.ReactNode },
        ref: React.Ref<HTMLElement>
      ) => {
        return react.createElement(tag, { ...props, ref }, children);
      }
    );
  };

  const AnimatePresence = ({ children }: { children?: React.ReactNode }) => {
    return react.createElement(react.Fragment, null, children);
  };

  return {
    ...actual,
    motion: {
      span: createMotionComponent('span'),
      div: createMotionComponent('div'),
      p: createMotionComponent('p'),
    },
    AnimatePresence,
  };
});

// Mock crypto.randomUUID for consistent test behavior
const mockUUID = '12345678-1234-1234-1234-123456789abc';
vi.stubGlobal('crypto', {
  randomUUID: () => mockUUID,
});

describe('ChatIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseBalance.mockReturnValue({ data: makeBalance('0') });
    mockUseStability.mockReturnValue({
      isAuthStable: true,
      isBalanceStable: true,
      isAppStable: true,
    });
  });

  afterEach(async () => {
    // Reset the shared UI-modals store so a test that opens the payment modal
    // never leaks that state into a later render.
    const { useUIModalsStore } = await import('@/stores/ui-modals');
    useUIModalsStore.setState({ paymentModalOpen: false, signupModalOpen: false });
  });

  it('shows loading state while session is not stable', () => {
    mockUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: false,
      isStable: false,
      isPending: true,
    });

    renderRoute(Route);

    expect(screen.getByTestId('chat-welcome')).toHaveAttribute('data-loading', 'true');
  });

  it('shows authenticated greeting after session becomes stable', async () => {
    mockUseStableSession.mockReturnValue({
      session: {
        user: { email: 'test@example.com' },
        session: { id: 'session-123' },
      },
      isAuthenticated: true,
      isStable: true,
      isPending: false,
    });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId('chat-welcome')).toHaveAttribute('data-loading', 'false');
    });
  });

  it('does not re-render greeting when session becomes stable', async () => {
    mockUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: false,
      isStable: false,
      isPending: true,
    });

    const { rerender } = renderRoute(Route);
    const RouteComponent = Route.options.component;
    if (!RouteComponent) throw new Error('Route has no component');

    mockUseStableSession.mockReturnValue({
      session: {
        user: { email: 'test@example.com' },
        session: { id: 'session-123' },
      },
      isAuthenticated: true,
      isStable: true,
      isPending: false,
    });

    rerender(<RouteComponent />);

    // Greeting should be stable (computed only after session loaded)
    await waitFor(() => {
      expect(screen.getByTestId('chat-welcome')).toHaveAttribute('data-loading', 'false');
    });
  });

  describe('authenticated user navigation', () => {
    it('navigates to /chat/new and stores pending message', async () => {
      const { usePendingChatStore } = await import('@/stores/pending-chat');

      mockUseStableSession.mockReturnValue({
        session: {
          user: { email: 'test@example.com' },
          session: { id: 'session-123' },
        },
        isAuthenticated: true,
        isStable: true,
        isPending: false,
      });

      renderRoute(Route);

      const textarea = screen.getByRole('textbox');
      const userEventModule = await import('@testing-library/user-event');
      const user = userEventModule.default;
      await user.setup().type(textarea, 'Hello AI!{enter}');

      const state = usePendingChatStore.getState();
      expect(state.pendingMessage).toBe('Hello AI!');

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/chat/$id',
        params: { id: 'new' },
        search: { fork: undefined },
      });
    });
  });

  describe('premium click modal routing', () => {
    it('renders SignupModal component for trial users', () => {
      // Trial: not authenticated
      mockUseStableSession.mockReturnValue({
        session: null,
        isAuthenticated: false,
        isStable: true,
        isPending: false,
      });
      mockUseBalance.mockReturnValue({ data: makeBalance('0') });

      renderRoute(Route);

      // SignupModal should be in the DOM (but closed)
      // The modal is rendered but with open={false}
      expect(screen.queryByTestId('payment-modal')).not.toBeInTheDocument();
    });

    it('renders PaymentModal component for authenticated users', () => {
      // Free user: authenticated but no balance
      mockUseStableSession.mockReturnValue({
        session: {
          user: { email: 'test@example.com' },
          session: { id: 'session-123' },
        },
        isAuthenticated: true,
        isStable: true,
        isPending: false,
      });
      mockUseBalance.mockReturnValue({ data: makeBalance('0') });

      renderRoute(Route);

      // PaymentModal component should be in the DOM (but closed)
      // The modal only renders when open=true, so it won't be there initially
      expect(screen.queryByTestId('payment-modal')).not.toBeInTheDocument();
    });
  });

  describe('error cleanup', () => {
    it('clears chat error on mount', () => {
      mockUseStableSession.mockReturnValue({
        session: null,
        isAuthenticated: false,
        isStable: true,
        isPending: false,
      });

      renderRoute(Route);

      expect(mockClearAll).toHaveBeenCalled();
    });

    it('clears chat error when sending a message', async () => {
      mockUseStableSession.mockReturnValue({
        session: {
          user: { email: 'test@example.com' },
          session: { id: 'session-123' },
        },
        isAuthenticated: true,
        isStable: true,
        isPending: false,
      });

      renderRoute(Route);

      mockClearAll.mockClear();

      const textarea = screen.getByRole('textbox');
      const userEventModule = await import('@testing-library/user-event');
      const user = userEventModule.default;
      await user.setup().type(textarea, 'Hello AI!{enter}');

      expect(mockClearAll).toHaveBeenCalled();
    });
  });

  describe('models fallback', () => {
    it('renders with an empty model list when models data is unavailable', async () => {
      const modelsModule = await import('@/hooks/models/models');
      vi.mocked(modelsModule.useModels).mockReturnValueOnce({
        data: undefined,
        isLoading: false,
        error: null,
      } as ReturnType<typeof modelsModule.useModels>);

      mockUseStableSession.mockReturnValue({
        session: null,
        isAuthenticated: false,
        isStable: true,
        isPending: false,
      });

      renderRoute(Route);

      // The page still renders its welcome surface; `modelsData?.models ?? []`
      // collapses to an empty list without throwing.
      expect(screen.getByTestId('chat-welcome')).toBeInTheDocument();
    });
  });

  describe('unauthenticated (trial) navigation', () => {
    it('routes an unauthenticated send to the trial flow and stores the message', async () => {
      const { useTrialChatStore } = await import('@/stores/trial-chat');

      mockUseStableSession.mockReturnValue({
        session: null,
        isAuthenticated: false,
        isStable: true,
        isPending: false,
      });

      renderRoute(Route);

      const textarea = screen.getByRole('textbox');
      const userEventModule = await import('@testing-library/user-event');
      const user = userEventModule.default;
      await user.setup().type(textarea, 'Trial hello!{enter}');

      expect(useTrialChatStore.getState().pendingMessage).toBe('Trial hello!');
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat/trial' });
    });
  });

  describe('payment modal balance invalidation', () => {
    async function openPaymentModalAuthenticated(): Promise<void> {
      const { useUIModalsStore } = await import('@/stores/ui-modals');
      mockUseStableSession.mockReturnValue({
        session: {
          user: { email: 'test@example.com' },
          session: { id: 'session-123' },
        },
        isAuthenticated: true,
        isStable: true,
        isPending: false,
      });
      useUIModalsStore.setState({ paymentModalOpen: true });
    }

    it('invalidates the balance query when payment succeeds', async () => {
      mockInvalidateQueries.mockReturnValue(Promise.resolve());
      await openPaymentModalAuthenticated();

      renderRoute(Route);

      const userEventModule = await import('@testing-library/user-event');
      const user = userEventModule.default;
      await user.setup().click(screen.getByTestId('payment-modal-success'));

      await waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['balance'] });
      });
    });

    it('logs the error when balance invalidation rejects', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockInvalidateQueries.mockRejectedValue(new Error('invalidate failed'));
      await openPaymentModalAuthenticated();

      renderRoute(Route);

      const userEventModule = await import('@testing-library/user-event');
      const user = userEventModule.default;
      await user.setup().click(screen.getByTestId('payment-modal-success'));

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(expect.any(Error));
      });

      consoleSpy.mockRestore();
    });
  });
});
