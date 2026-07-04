import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { authClient } from '@/lib/auth';
import { renderRoute } from '@/test-utils/render';
import { Route, type BillingPortalSearch } from './billing-portal';

// Keep the real router (createFileRoute must run); stub only Link, which needs
// router context renderRoute does not provide.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
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
    tokenLogin: vi.fn(),
  },
}));

// BillingContent runs live balance/transaction queries; the ready-state contract
// is only that it is mounted, so stub it to a marker.
vi.mock('@/components/billing/billing-content', () => ({
  BillingContent: (): React.JSX.Element => <div data-testid="billing-content" />,
}));

vi.mock('@/components/shared/theme-toggle', () => ({
  ThemeToggle: (): React.JSX.Element => <div data-testid="theme-toggle" />,
}));

function setSearch(search: BillingPortalSearch): void {
  vi.spyOn(Route, 'useSearch').mockReturnValue(search);
}

describe('/billing-portal validateSearch', () => {
  const validateSearch = Route.options.validateSearch as (
    search: Record<string, unknown>
  ) => BillingPortalSearch;

  it('extracts a string token', () => {
    expect(validateSearch({ token: 'tok-123' })).toEqual({ token: 'tok-123' });
  });

  it('returns undefined token when missing', () => {
    expect(validateSearch({})).toEqual({ token: undefined });
  });

  it('returns undefined token when not a string', () => {
    expect(validateSearch({ token: 42 })).toEqual({ token: undefined });
    expect(validateSearch({ token: null })).toEqual({ token: undefined });
  });
});

describe('/billing-portal route component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the loading spinner while exchanging the token', () => {
    setSearch({ token: 'tok-123' });
    // Never-resolving promise keeps the component in its loading state.
    vi.mocked(authClient.tokenLogin).mockReturnValue(new Promise(() => {}));

    const { container } = renderRoute(Route);

    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.billingPortal)).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.billingPortalError)).not.toBeInTheDocument();
  });

  it('renders the portal chrome and billing content after a successful exchange', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortal)).toBeInTheDocument();
    });
    expect(authClient.tokenLogin).toHaveBeenCalledWith({ token: 'tok-123' });
    expect(screen.getByTestId('billing-content')).toBeInTheDocument();
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /hushbox/i })).toHaveAttribute('href', '/chat');
  });

  it('shows the expired-link error with the failure message', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.getByText('Token expired')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /link expired/i })).toBeInTheDocument();
  });

  // The three sizing tests below pin h-full, not h-dvh: the root route's h-dvh
  // banner-row layout owns the viewport height, and a viewport unit here would
  // overflow the content region by the banner's height when a banner is active.
  it('sizes the loading state to its container, not the viewport', () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockReturnValue(new Promise(() => {}));

    const { container } = renderRoute(Route);

    expect(container.querySelector('.animate-spin')?.parentElement).toHaveClass('h-full');
  });

  it('sizes the error state to its container, not the viewport', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({ error: { message: 'Token expired' } });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortalError)).toBeInTheDocument();
    });
    expect(screen.getByTestId(TEST_IDS.billingPortalError).parentElement).toHaveClass('h-full');
  });

  it('sizes the portal chrome to its container, not the viewport', async () => {
    setSearch({ token: 'tok-123' });
    vi.mocked(authClient.tokenLogin).mockResolvedValue({});

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.billingPortal)).toBeInTheDocument();
    });
    expect(screen.getByTestId(TEST_IDS.billingPortal)).toHaveClass('h-full');
  });

  it('redirects to /login when no token is present', () => {
    setSearch({ token: undefined });
    const hrefSetter = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
      set href(value: string) {
        hrefSetter(value);
      },
    } as unknown as Location);

    renderRoute(Route);

    expect(hrefSetter).toHaveBeenCalledWith('/login');
    expect(authClient.tokenLogin).not.toHaveBeenCalled();
  });
});
