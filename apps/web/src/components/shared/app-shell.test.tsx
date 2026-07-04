import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import type { ReactNode } from 'react';
vi.mock('@/lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
}));

import { useUIStore } from '@/stores/ui';
import { useModelValidation } from '@/hooks/models/use-model-validation';
import { AppShell } from './app-shell';

vi.mock('@/hooks/models/use-model-validation', () => ({
  useModelValidation: vi.fn(),
}));

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: vi.fn(() => ({
    data: [],
    isLoading: false,
  })),
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
  useParams: () => ({ conversationId: undefined }),
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
