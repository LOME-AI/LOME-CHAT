import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { Route } from './__root';

// __root uses createRootRouteWithContext (the root route is always eager, so the
// code-splitting guardrail exempts it). Keep the real router so the route object
// is genuine, and source RootComponent from Route.options.component — but the
// component still renders Outlet/Navigate/useRouter, which need router context
// renderRoute/render does not provide, so those are stubbed here. The full
// provider tree is likewise stubbed to pass-throughs: this test asserts the
// shell's always-on regions render, not the providers' internals.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Outlet: () => <div data-testid="outlet" />,
    Navigate: () => null,
    useNavigate: vi.fn(() => vi.fn()),
    useRouter: () => ({ subscribe: vi.fn(() => vi.fn()) }),
  };
});

vi.mock('@/providers/query-provider', () => ({
  QueryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/providers/stability-provider', () => ({
  StabilityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useStability: () => ({ isAppStable: true }),
}));

vi.mock('@/providers/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/capacitor', () => ({
  CapacitorProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/shared/upgrade-required-modal', () => ({
  UpgradeRequiredModal: () => <div data-testid="upgrade-required-modal" />,
}));

vi.mock('@/components/shared/offline-overlay', () => ({
  OfflineOverlay: () => <div data-testid="offline-overlay" />,
}));

vi.mock('@/components/banner/announcement-banner', () => ({
  AnnouncementBanner: () => <div data-testid="announcement-banner" />,
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return { ...actual, ROUTES: { CHAT: '/chat' } };
});

vi.mock('@hushbox/ui/accessibility', () => ({
  A11yProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MotionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AccessibilityWidget: () => null,
  AccessibilityPanel: () => null,
  AccessibilityPage: () => null,
  SvgColorblindDefs: () => null,
}));

vi.mock('@/lib/tts-dom-observer', () => ({
  installTtsDomObserver: () => () => {},
}));

vi.mock('@/components/shared/settled-indicator', () => ({
  SettledIndicator: () => <div data-testid="settled-indicator" />,
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return { ...actual, Toaster: () => <div data-testid="toaster" /> };
});

vi.mock('@/stores/touch-override', () => ({
  useTouchOverrideStore: () => null,
}));

describe('root route', () => {
  const RootComponent = Route.options.component as React.ComponentType;

  it('renders OfflineOverlay', () => {
    render(<RootComponent />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlay)).toBeInTheDocument();
  });

  it('renders UpgradeRequiredModal', () => {
    render(<RootComponent />);

    expect(screen.getByTestId(TEST_IDS.upgradeRequiredModal)).toBeInTheDocument();
  });

  it('renders the route announcer live region', () => {
    render(<RootComponent />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('wraps the banner row and outlet in the viewport-height contract', () => {
    render(<RootComponent />);

    // The wrapper around the banner owns the mobile viewport-height contract
    // (h-dvh moved here off AppShell, which is h-full inside it); the content
    // region's min-h-0 flex-1 is the other half — without it the banner row
    // pushes route content past the viewport instead of shrinking it.
    const viewport = screen.getByTestId('announcement-banner').parentElement;
    expect(viewport).toHaveClass('h-dvh');
    expect(viewport).toHaveClass('flex');
    expect(viewport).toHaveClass('flex-col');

    const contentRegion = screen.getByTestId('outlet').parentElement;
    expect(contentRegion).toHaveClass('min-h-0');
    expect(contentRegion).toHaveClass('flex-1');
  });
});
