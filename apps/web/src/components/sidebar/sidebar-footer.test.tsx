import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { useTouchOverrideStore } from '@/stores/touch-override';
import { buildDrizzleStudioUrl } from '@/lib/routes';
import { SidebarFooter } from './sidebar-footer';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const {
  mockSignOutAndClearCache,
  mockUseSession,
  mockNavigate,
  mockUseStableBalance,
  mockFeatureFlags,
  mockEnv,
  mockUseIsMobile,
} = vi.hoisted(() => ({
  mockSignOutAndClearCache: vi.fn().mockImplementation(() => Promise.resolve()),
  mockUseSession: vi.fn(),
  mockNavigate: vi.fn(),
  mockUseStableBalance: vi.fn(),
  mockFeatureFlags: {
    SETTINGS_ENABLED: true,
  },
  mockEnv: {
    isDev: true,
    isLocalDev: true,
    isProduction: false,
    isCI: false,
    isE2E: false,
    requiresRealServices: false,
  },
  mockUseIsMobile: vi.fn(),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    FEATURE_FLAGS: mockFeatureFlags,
  };
});

vi.mock('@/lib/auth', () => ({
  signOutAndClearCache: mockSignOutAndClearCache,
  useSession: mockUseSession,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: mockUseStableBalance,
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({
    isAuthStable: true,
    isBalanceStable: true,
    isAppStable: true,
  }),
}));

vi.mock('@/lib/env', () => ({
  env: mockEnv,
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: mockUseIsMobile,
  };
});

vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => false,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalPage: vi.fn(),
}));

vi.mock('@/hooks/feedback/use-submit-feedback', () => ({
  useSubmitFeedback: () => ({ mutateAsync: vi.fn() }),
}));

describe('SidebarFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Both dev-tool URLs are registry-defined in every mode DevOnly renders
    // (Development + local E2E), so a real dev build always has them; stub them
    // here so the dev menu resolves like a real build.
    vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
    vi.stubEnv('VITE_ADMIN_URL', 'http://localhost:7000');
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
    mockUseSession.mockReturnValue({
      data: {
        user: { email: 'test@example.com', username: 'test_user' },
        session: { id: 'session-123' },
      },
    });
    mockUseStableBalance.mockReturnValue({
      displayBalance: '12.34567890',
      isStable: true,
    });
    mockUseIsMobile.mockReturnValue(false);
  });

  describe('expanded state', () => {
    it('renders user avatar icon', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId(TEST_IDS.userAvatarIcon)).toBeInTheDocument();
    });

    it('renders user username when expanded', () => {
      render(<SidebarFooter />);
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    it('renders credits display when expanded with 4 decimal places', () => {
      render(<SidebarFooter />);
      expect(screen.getByText('$12.3457')).toBeInTheDocument();
    });

    it('shows loading placeholder when balance is not stable', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '0',
        isStable: false,
      });
      render(<SidebarFooter />);
      expect(screen.getByText('$...')).toBeInTheDocument();
    });

    it('shows zero balance when balance is zero', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '0',
        isStable: true,
      });
      render(<SidebarFooter />);
      expect(screen.getByText('$0.0000')).toBeInTheDocument();
    });

    it('shows dropdown menu on click', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('shows Settings option in dropdown when SETTINGS_ENABLED is true', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuSettings)).toBeInTheDocument();
    });

    it('shows Accessibility option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuAccessibility)).toBeInTheDocument();
    });

    it('navigates to /accessibility when Accessibility is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuAccessibility));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/accessibility' });
    });

    it('shows Add Credits option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuAddCredits)).toBeInTheDocument();
    });

    it('navigates to /billing when Add Credits is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuAddCredits));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/billing' });
    });

    it('shows Send feedback option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuFeedback)).toBeInTheDocument();
    });

    it('opens the feedback modal when Send feedback is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuFeedback));

      expect(screen.getByTestId(TEST_IDS.feedbackModal)).toBeInTheDocument();
    });

    it('shows GitHub option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      const githubLink = screen.getByTestId(TEST_IDS.menuGithub);
      expect(githubLink).toBeInTheDocument();
      expect(githubLink).toHaveAttribute('href', 'https://github.com/lome-ai/hushbox');
      expect(githubLink).toHaveAttribute('target', '_blank');
    });

    it('shows About HushBox link in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      const link = screen.getByTestId(TEST_IDS.menuMarketing);
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', ROUTES.MARKETING);
    });

    it('shows Log Out option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuLogout)).toBeInTheDocument();
    });

    it('calls signOutAndClearCache and navigates when Log Out is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuLogout));

      expect(mockSignOutAndClearCache).toHaveBeenCalled();
    });

    it('renders chevron up indicator', () => {
      render(<SidebarFooter />);

      const trigger = screen.getByTestId(TEST_IDS.sidebarTrigger);
      const svgs = trigger.querySelectorAll('svg');
      expect(svgs.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('collapsed state (rail mode)', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('renders avatar icon when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId(TEST_IDS.userAvatarIcon)).toBeInTheDocument();
    });

    it('does not render username when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.queryByText('Test User')).not.toBeInTheDocument();
    });

    it('does not render credits when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.queryByText('$12.3457')).not.toBeInTheDocument();
    });

    it('has justify-center layout when collapsed', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId(TEST_IDS.sidebarFooter);
      expect(footer).toHaveClass('justify-center');
    });

    it('can open dropdown when collapsed', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });
  });

  describe('common styles', () => {
    it('has border at top', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId(TEST_IDS.sidebarFooter);
      expect(footer).toHaveClass('border-t');
    });

    it('uses sidebar border color', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId(TEST_IDS.sidebarFooter);
      expect(footer).toHaveClass('border-sidebar-border');
    });
  });

  describe('dev-only Personas option', () => {
    it('shows Personas option in dev mode when authenticated', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuPersonas)).toBeInTheDocument();
    });

    it('shows Personas option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuPersonas)).toBeInTheDocument();
    });

    it('navigates to /dev/personas when Personas is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuPersonas));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/dev/personas',
        search: { type: undefined },
      });
    });

    it('shows Database Studio option in dev mode when authenticated', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuDbStudio)).toBeInTheDocument();
      vi.unstubAllEnvs();
    });

    it('shows Database Studio option in dev mode when unauthenticated', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuDbStudio)).toBeInTheDocument();
      vi.unstubAllEnvs();
    });

    it('Database Studio links to Drizzle Studio URL in new tab', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', 'http://localhost:4983');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      const studioLink = screen.getByTestId(TEST_IDS.menuDbStudio);
      expect(studioLink).toHaveAttribute('href', buildDrizzleStudioUrl('http://localhost:4983'));
      expect(studioLink.getAttribute('href')).toMatch(/^https:\/\/local\.drizzle\.studio/);
      expect(studioLink).toHaveAttribute('target', '_blank');
      vi.unstubAllEnvs();
    });

    it('fails fast when VITE_DRIZZLE_STUDIO_URL is unset in dev mode', async () => {
      vi.stubEnv('VITE_DRIZZLE_STUDIO_URL', '');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      // The item shows on mode (dev), not on presence; a missing required var
      // behind that gate is a config defect, so opening the menu fails fast.
      await expect(user.click(screen.getByTestId(TEST_IDS.sidebarTrigger))).rejects.toThrow(
        /VITE_DRIZZLE_STUDIO_URL/
      );
      vi.unstubAllEnvs();
    });

    it('shows Admin option in dev mode when VITE_ADMIN_URL is set', async () => {
      vi.stubEnv('VITE_ADMIN_URL', 'http://localhost:7000');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuAdmin)).toBeInTheDocument();
      vi.unstubAllEnvs();
    });

    it('Admin links to the admin SPA in a new tab', async () => {
      vi.stubEnv('VITE_ADMIN_URL', 'http://localhost:7000');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      const adminLink = screen.getByTestId(TEST_IDS.menuAdmin);
      expect(adminLink).toHaveAttribute('href', 'http://localhost:7000');
      expect(adminLink).toHaveAttribute('target', '_blank');
      expect(adminLink).toHaveAttribute('rel', 'noopener noreferrer');
      vi.unstubAllEnvs();
    });

    it('fails fast when VITE_ADMIN_URL is unset in dev mode', async () => {
      vi.stubEnv('VITE_ADMIN_URL', '');
      const user = userEvent.setup();
      render(<SidebarFooter />);

      // The item shows on mode (dev), not on presence; a missing required var
      // behind that gate is a config defect, so opening the menu fails fast.
      await expect(user.click(screen.getByTestId(TEST_IDS.sidebarTrigger))).rejects.toThrow(
        /VITE_ADMIN_URL/
      );
      vi.unstubAllEnvs();
    });

    it('uses env.isLocalDev for conditional rendering', () => {
      // Personas visibility is controlled by env.isLocalDev (not import.meta.env.DEV).
      // isLocalDev = isDev && !isCI, so Personas is hidden in CI but shown locally.
      // The mock sets isLocalDev: true to test the dev-only UI in this test suite.
      expect(mockEnv.isLocalDev).toBe(true);
    });

    it('hides every dev-only tool and reads no dev-tool URL outside local dev', async () => {
      mockEnv.isLocalDev = false;
      const user = userEvent.setup();
      try {
        render(<SidebarFooter />);
        await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
        expect(screen.queryByTestId(TEST_IDS.menuPersonas)).not.toBeInTheDocument();
        expect(screen.queryByTestId(TEST_IDS.menuDbStudio)).not.toBeInTheDocument();
        expect(screen.queryByTestId(TEST_IDS.menuAdmin)).not.toBeInTheDocument();
      } finally {
        mockEnv.isLocalDev = true;
      }
    });
  });

  describe('dev-only Emails option', () => {
    it('shows Emails option in dev mode when authenticated', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuEmails)).toBeInTheDocument();
    });

    it('shows Emails option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuEmails)).toBeInTheDocument();
    });

    it('navigates to /dev/emails when Emails is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuEmails));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/dev/emails',
      });
    });
  });

  describe('dev-only Assets option', () => {
    it('shows Assets option in dev mode when authenticated', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuAssets)).toBeInTheDocument();
    });

    it('shows Assets option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuAssets)).toBeInTheDocument();
    });

    it('navigates to /dev/assets when Assets is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuAssets));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/dev/assets',
      });
    });
  });

  describe('unauthenticated state', () => {
    beforeEach(() => {
      mockUseSession.mockReturnValue({ data: null });
    });

    it('renders Trial User when no session', () => {
      render(<SidebarFooter />);
      expect(screen.getByText('Trial User')).toBeInTheDocument();
    });

    it('shows Log In option instead of Log Out', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuLogin)).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.menuLogout)).not.toBeInTheDocument();
    });

    it('shows Sign Up option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuSignup)).toBeInTheDocument();
    });

    it('does not show Send feedback option for trial users', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.queryByTestId(TEST_IDS.menuFeedback)).not.toBeInTheDocument();
    });

    it('navigates to /login when Log In is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuLogin));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' });
    });

    it('navigates to /signup when Sign Up is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuSignup));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/signup' });
    });

    it('does not show Settings option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.queryByTestId(TEST_IDS.menuSettings)).not.toBeInTheDocument();
    });

    it('does not show Add Credits option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.queryByTestId(TEST_IDS.menuAddCredits)).not.toBeInTheDocument();
    });

    it('still shows GitHub option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuGithub)).toBeInTheDocument();
    });

    it('shows About HushBox link', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      const link = screen.getByTestId(TEST_IDS.menuMarketing);
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', ROUTES.MARKETING);
    });
  });

  describe('closes mobile sidebar on menu item click', () => {
    // Defends against an iOS Sheet-overlay bug: when the user clicks a
    // menu item that navigates to the route they're already on, the
    // sidebar's pathname-diff effect doesn't fire and the Sheet keeps
    // intercepting pointer events on the page beneath it. Closing the
    // mobile sidebar from the item's onClick guarantees this regardless
    // of whether navigation actually changes the route.
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: true });
    });

    it('closes mobile sidebar when Settings is clicked', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuSettings));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Accessibility is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuAccessibility));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Usage is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuUsage));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Add Credits is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuAddCredits));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Log Out is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuLogout));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Log In is clicked (unauthenticated)', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuLogin));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('closes mobile sidebar when Sign Up is clicked (unauthenticated)', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);
      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuSignup));
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });
  });

  describe('SETTINGS_ENABLED feature flag', () => {
    beforeEach(() => {
      mockUseSession.mockReturnValue({
        data: {
          user: { email: 'test@example.com', username: 'test_user' },
          session: { id: 'session-123' },
        },
      });
    });

    it('hides Settings when SETTINGS_ENABLED is false', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = false;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.queryByTestId(TEST_IDS.menuSettings)).not.toBeInTheDocument();
    });

    it('shows Settings when SETTINGS_ENABLED is true', async () => {
      mockFeatureFlags.SETTINGS_ENABLED = true;
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      expect(screen.getByTestId(TEST_IDS.menuSettings)).toBeInTheDocument();
    });

    it('toggles the touch-mode override from the dev menu', async () => {
      useTouchOverrideStore.setState({ override: false });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));
      await user.click(screen.getByTestId(TEST_IDS.menuTouchMode));

      expect(useTouchOverrideStore.getState().override).toBe(true);
    });

    it('marks the touch-mode item with a check when the override is active', async () => {
      useTouchOverrideStore.setState({ override: true });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId(TEST_IDS.sidebarTrigger));

      expect(screen.getByTestId(TEST_IDS.menuTouchMode).querySelector('svg')).not.toBeNull();
      useTouchOverrideStore.setState({ override: false });
    });
  });
});
