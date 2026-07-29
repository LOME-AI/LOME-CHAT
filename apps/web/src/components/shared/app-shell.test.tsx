import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import type { ReactNode } from 'react';
vi.mock('@/lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
}));

import { useUIStore } from '@/stores/ui';
import { useNotificationActivityStore } from '@/stores/notification-activity';
import { useModelValidation } from '@/hooks/models/use-model-validation';
import { usePushRegistration } from '@/hooks/notifications/use-push-registration';
import { AppShell } from './app-shell';

vi.mock('@/hooks/models/use-model-validation', () => ({
  useModelValidation: vi.fn(),
}));

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: vi.fn(() => ({
    data: [],
    isLoading: false,
  })),
  useConversations: vi.fn(() => ({
    data: [],
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  })),
  chatKeys: {
    all: ['chat'] as const,
    conversations: () => ['chat', 'conversations'] as const,
  },
  useDeleteConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  DECRYPTING_TITLE: 'Decrypting...',
}));

/** The route params the shell reads non-strictly; set per test. */
const { routeParams } = vi.hoisted(() => ({
  routeParams: { current: {} as { id?: string; conversationId?: string } },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' }),
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useParams: () => routeParams.current,
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: () => ({
    displayBalance: '10.00',
    isStable: true,
  }),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({
    isAuthStable: true,
    isBalanceStable: true,
    isAppStable: true,
  }),
}));

vi.mock('@/hooks/notifications/use-push-registration', () => ({
  usePushRegistration: vi.fn(),
}));

vi.mock('@/hooks/notifications/use-enable-prompt', () => ({
  useEnablePrompt: vi.fn(() => ({
    isVisible: true,
    isEnabling: false,
    enable: vi.fn(),
    dismiss: vi.fn(),
  })),
}));

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('AppShell', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true });
  });

  it('renders children', () => {
    render(
      <AppShell>
        <div data-testid="child-content">Hello World</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('presents observed notification activity', () => {
    document.title = 'HushBox';
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    act(() => {
      useNotificationActivityStore.setState({ unreadCount: 2 });
    });

    expect(document.title).toBe('(2) HushBox');
    useNotificationActivityStore.setState({ unreadCount: 0 });
  });

  it('renders Sidebar', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    expect(screen.getByRole('complementary')).toBeInTheDocument();
  });

  it('has flex layout', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    const shell = screen.getByTestId(TEST_IDS.appShell);
    expect(shell).toHaveClass('flex');
  });

  it('fills its container height', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    const shell = screen.getByTestId(TEST_IDS.appShell);
    // h-full, not h-dvh: the root route's h-dvh flex column owns the viewport
    // height; the shell fills the flex-1 content region below the app-wide banner.
    expect(shell).toHaveClass('h-full');
  });

  it('renders main content area', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('main area takes remaining space', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    const main = screen.getByRole('main');
    expect(main).toHaveClass('flex-1');
  });

  it('main area handles overflow', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    const main = screen.getByRole('main');
    expect(main).toHaveClass('overflow-hidden');
  });

  it('renders portal target for right sidebar', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    const portalTarget = document.querySelector('#right-sidebar-portal');
    expect(portalTarget).toBeInTheDocument();
    expect(portalTarget).toHaveClass('contents');
  });

  it('re-registers this device for push once the shell mounts', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(usePushRegistration).toHaveBeenCalled();
  });

  it('offers notifications from the sidebar, never from the main region', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(
      within(screen.getByRole('complementary')).getByRole('button', { name: 'Enable' })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('main')).queryByRole('button', { name: 'Enable' })
    ).not.toBeInTheDocument();
  });

  it('never asks the browser for notification permission on mount', () => {
    const requestPermission = vi.fn();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });

    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(requestPermission).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('calls useModelValidation to validate cached model selection', () => {
    vi.mocked(useModelValidation).mockClear();

    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(useModelValidation).toHaveBeenCalled();
  });

  describe('the funding scope handed to model validation', () => {
    function renderShell(): void {
      vi.mocked(useModelValidation).mockClear();
      render(
        <AppShell>
          <div>Content</div>
        </AppShell>,
        { wrapper: createWrapper() }
      );
    }

    it('is the open conversation on a chat route', () => {
      routeParams.current = { id: 'conv-7' };
      renderShell();
      expect(useModelValidation).toHaveBeenCalledWith('conv-7');
    });

    it('is the shared conversation on the link-guest share route', () => {
      routeParams.current = { conversationId: 'conv-shared' };
      renderShell();
      expect(useModelValidation).toHaveBeenCalledWith('conv-shared');
    });

    it('is none for a conversation that does not exist yet', () => {
      routeParams.current = { id: 'new' };
      renderShell();
      expect(useModelValidation).toHaveBeenCalledWith(null);
    });

    it('is none on a route that names no conversation', () => {
      routeParams.current = {};
      renderShell();
      expect(useModelValidation).toHaveBeenCalledWith(null);
    });
  });

  it('renders a skip-to-content link as the first focusable element', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    const shell = screen.getByTestId(TEST_IDS.appShell);
    const focusables = shell.querySelectorAll('a, button, input, [tabindex]');
    expect(focusables[0]).toBe(screen.getByRole('link', { name: /skip to content/i }));
  });

  it('points the skip link at the main content region', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(screen.getByRole('link', { name: /skip to content/i })).toHaveAttribute('href', '#main');
  });

  it('gives main a focusable target for the skip link', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
  });
});
