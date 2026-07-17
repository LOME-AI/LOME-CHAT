import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useSearch } from '@tanstack/react-router';
import { toast } from '@hushbox/ui';
import { authClient } from '@/lib/auth';
import { renderRoute } from '@/test-utils/render';
import { Route } from './verify';

// Keep the real router (createFileRoute must run for the route file); mock only
// the navigation/link/search hooks the page touches.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useSearch: vi.fn(() => ({ token: 'test-token' })),
    useNavigate: vi.fn(() => vi.fn()),
    Link: ({
      children,
      to,
      className,
    }: {
      children: React.ReactNode;
      to: string;
      className?: string;
    }): React.JSX.Element => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

vi.mock('@/lib/auth', () => ({
  authClient: {
    verifyEmail: vi.fn(),
  },
}));

// Keep the real @hushbox/ui (providers depend on it); override only `toast`.
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
    },
  };
});

describe('VerifyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearch).mockReturnValue({ token: 'test-token' });
  });

  it('shows loading state initially', () => {
    vi.mocked(authClient.verifyEmail).mockImplementation(
      // Promise that never resolves to keep loading state
      () => new Promise(() => {})
    );

    renderRoute(Route);

    expect(screen.getByText(/verifying/i)).toBeInTheDocument();
  });

  it('shows success state on successful verification', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({});

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith('Email verified successfully!');
    expect(screen.getByRole('link', { name: /continue to login/i })).toHaveAttribute(
      'href',
      '/login'
    );
  });

  it('shows error state on verification failure', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({
      error: { message: 'Invalid or expired token' },
    });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
    expect(screen.getByText('Invalid or expired token')).toBeInTheDocument();
    expect(screen.getByText(/log in to receive a new verification email/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to login/i })).toBeInTheDocument();
  });

  it('shows default error message when no specific message', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({
      error: { message: '' },
    });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
    expect(screen.getByText('This verification link has expired.')).toBeInTheDocument();
    expect(screen.getByText(/log in to receive a new verification email/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to login/i })).toHaveAttribute('href', '/login');
  });

  it('shows error state on network failure', async () => {
    vi.mocked(authClient.verifyEmail).mockRejectedValue(new Error('Network error'));

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
    expect(screen.getByText('Verification failed. Please try again.')).toBeInTheDocument();
    expect(screen.getByText(/log in to receive a new verification email/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to login/i })).toBeInTheDocument();
  });
});

describe('VerifyPage idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearch).mockReturnValue({ token: 'idempotency-token' });
  });

  it('fires verifyEmail at most once when the effect runs twice for the same token', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({});

    const Component = Route.options.component!;
    const { StrictMode } = await import('react');
    const { renderWithProviders } = await import('@/test-utils/render');
    renderWithProviders(
      <StrictMode>
        <Component />
      </StrictMode>
    );

    await waitFor(() => {
      expect(authClient.verifyEmail).toHaveBeenCalled();
    });

    expect(authClient.verifyEmail).toHaveBeenCalledTimes(1);
  });

  it('still transitions to the success state when the effect runs twice', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({});

    const Component = Route.options.component!;
    const { StrictMode } = await import('react');
    const { renderWithProviders } = await import('@/test-utils/render');
    renderWithProviders(
      <StrictMode>
        <Component />
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith('Email verified successfully!');
  });

  it('does not re-verify a token it has already sent for when it reappears', async () => {
    // Guard on the sent-token ref: the effect re-runs when the token flips to a
    // falsy value and back, but the ref still holds the original token, so the
    // second appearance short-circuits without a second verifyEmail call.
    vi.mocked(authClient.verifyEmail).mockResolvedValue({});
    vi.mocked(useSearch).mockReturnValue({ token: 'idempotency-token' });

    const Component = Route.options.component!;
    const { renderWithProviders } = await import('@/test-utils/render');
    const { rerender } = renderWithProviders(<Component />);

    await waitFor(() => {
      expect(authClient.verifyEmail).toHaveBeenCalledTimes(1);
    });

    vi.mocked(useSearch).mockReturnValue({ token: undefined });
    rerender(<Component />);

    vi.mocked(useSearch).mockReturnValue({ token: 'idempotency-token' });
    rerender(<Component />);

    expect(authClient.verifyEmail).toHaveBeenCalledTimes(1);
  });
});

describe('VerifyPage without token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearch).mockReturnValue({ token: undefined });
  });

  it('shows error when no token provided', () => {
    renderRoute(Route);

    expect(screen.getByText(/no verification token/i)).toBeInTheDocument();
  });
});
