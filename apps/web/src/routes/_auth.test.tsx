import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { redirect } from '@tanstack/react-router';
import { authClient } from '@/lib/auth';
import { renderRoute } from '@/test-utils/render';
import { Route } from './_auth';

const { redirectError } = vi.hoisted(() => ({ redirectError: new Error('REDIRECT') }));

// Keep the real router (createFileRoute must run); mock only the pieces the layout/guard touch.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Outlet: (): React.JSX.Element => <div data-testid="outlet">Outlet Content</div>,
    redirect: vi.fn(() => {
      throw redirectError;
    }),
    Link: ({
      children,
      to,
      ...props
    }: {
      children: React.ReactNode;
      to: string;
    }): React.JSX.Element => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

vi.mock('@/lib/auth', () => ({
  authClient: {
    getSession: vi.fn(),
  },
}));

// CipherWall uses the Canvas API, unavailable in jsdom.
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    CipherWall: (): React.JSX.Element => <div data-testid="cipher-wall">cipher wall</div>,
  };
});

describe('AuthLayout component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders theme toggle in top-right of form area', async () => {
    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
    });
  });

  it('renders logo as a link to /chat in top-left', async () => {
    renderRoute(Route);

    await waitFor(() => {
      const logoLink = screen.getByRole('link', { name: /hushbox/i });
      expect(logoLink).toBeInTheDocument();
      expect(logoLink).toHaveAttribute('href', '/chat');
    });
  });

  it('positions logo at top-4 left-4 (safe area handled globally by body)', () => {
    renderRoute(Route);

    const logoLink = screen.getByRole('link', { name: /hushbox/i });
    const logoContainer = logoLink.parentElement!;
    expect(logoContainer).toHaveClass('top-4', 'left-4');
  });

  it('positions theme toggle at top-4 right-4 (safe area handled globally by body)', () => {
    renderRoute(Route);

    const themeToggle = screen.getByTestId('theme-toggle');
    const toggleContainer = themeToggle.parentElement!;
    expect(toggleContainer).toHaveClass('top-4', 'right-4');
  });

  it('uses pt-14 for content padding (safe area handled globally by body)', () => {
    renderRoute(Route);

    const layout = screen.getByTestId('auth-layout');
    const formArea = layout.children[0] as HTMLElement;
    expect(formArea).toHaveClass('pt-14');
  });

  it('renders split-screen layout', () => {
    renderRoute(Route);

    expect(screen.getByTestId('auth-layout')).toBeInTheDocument();
  });

  it('renders outlet for child content', () => {
    renderRoute(Route);

    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('has split-screen flex layout', () => {
    renderRoute(Route);

    const container = screen.getByTestId('auth-layout');
    // min-h-full, not min-h-dvh: the root route's h-dvh banner-row layout owns
    // the viewport height; the auth layout fills the flex-1 content region
    // below the app-wide banner.
    expect(container).toHaveClass('min-h-full');
    expect(container).toHaveClass('flex');
  });

  it('renders cipher wall in right column', () => {
    renderRoute(Route);

    expect(screen.getByTestId('cipher-wall')).toBeInTheDocument();
  });

  it('grows with content instead of clipping it', () => {
    renderRoute(Route);

    const container = screen.getByTestId('auth-layout');
    // min-h-full lets the layout grow past the root's content region when the
    // form is taller; no overflow-hidden here, so this container never clips
    // taller content.
    expect(container).toHaveClass('min-h-full');
    expect(container).not.toHaveClass('overflow-hidden');
  });
});

describe('Auth route beforeLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to /chat when user is authenticated', async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
        },
      },
    });

    const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
    await expect(beforeLoad?.()).rejects.toThrow('REDIRECT');
    expect(redirect).toHaveBeenCalledWith({ to: '/chat' });
  });

  it('does not redirect when user is not authenticated', async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: null,
    });

    const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
    await beforeLoad?.();

    expect(redirect).not.toHaveBeenCalled();
  });
});
