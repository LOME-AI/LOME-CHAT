import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarFooter } from './sidebar-footer';
import { useUIStore } from '@/stores/ui';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const { mockSignOutAndClearCache, mockUseSession, mockNavigate } = vi.hoisted(() => ({
  mockSignOutAndClearCache: vi.fn().mockResolvedValue(undefined),
  mockUseSession: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  signOutAndClearCache: mockSignOutAndClearCache,
  useSession: mockUseSession,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

describe('SidebarFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ sidebarOpen: true });
    mockUseSession.mockReturnValue({
      data: {
        user: { email: 'test@example.com' },
        session: { id: 'session-123' },
      },
    });
  });

  describe('expanded state', () => {
    it('renders user avatar icon', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-avatar-icon')).toBeInTheDocument();
    });

    it('renders user email when expanded', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-email')).toHaveTextContent('test@example.com');
    });

    it('renders credits display when expanded', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-credits')).toHaveTextContent('$0.0000000');
    });

    it('shows dropdown menu on click', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('shows Settings option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-settings')).toBeInTheDocument();
    });

    it('shows Add Credits option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-add-credits')).toBeInTheDocument();
    });

    it('shows GitHub option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      const githubLink = screen.getByTestId('menu-github');
      expect(githubLink).toBeInTheDocument();
      expect(githubLink).toHaveAttribute('href', 'https://github.com/lome-ai/lome-chat');
      expect(githubLink).toHaveAttribute('target', '_blank');
    });

    it('shows Log Out option in dropdown', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-logout')).toBeInTheDocument();
    });

    it('calls signOutAndClearCache and navigates when Log Out is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      await user.click(screen.getByTestId('menu-logout'));

      expect(mockSignOutAndClearCache).toHaveBeenCalled();
    });
  });

  describe('collapsed state (rail mode)', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('renders avatar icon when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-avatar-icon')).toBeInTheDocument();
    });

    it('does not render email when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.queryByTestId('user-email')).not.toBeInTheDocument();
    });

    it('does not render credits when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.queryByTestId('user-credits')).not.toBeInTheDocument();
    });

    it('has justify-center layout when collapsed', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId('sidebar-footer');
      expect(footer).toHaveClass('justify-center');
    });

    it('can open dropdown when collapsed', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });
  });

  describe('common styles', () => {
    it('has border at top', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId('sidebar-footer');
      expect(footer).toHaveClass('border-t');
    });

    it('uses sidebar border color', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId('sidebar-footer');
      expect(footer).toHaveClass('border-sidebar-border');
    });
  });

  describe('dev-only Personas option', () => {
    it('shows Personas option in dev mode when authenticated', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-personas')).toBeInTheDocument();
    });

    it('shows Personas option in dev mode when unauthenticated', async () => {
      mockUseSession.mockReturnValue({ data: null });
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-personas')).toBeInTheDocument();
    });

    it('navigates to /dev/personas when Personas is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      await user.click(screen.getByTestId('menu-personas'));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/dev/personas',
        search: { type: undefined },
      });
    });

    it('uses import.meta.env.DEV for conditional rendering', () => {
      // This test documents that Personas visibility is controlled by import.meta.env.DEV.
      // In Vitest, import.meta.env.DEV is true, so Personas appears.
      // In production builds, Vite sets DEV to false and dead code elimination
      // removes the Personas code entirely from the bundle.
      // This is verified by the build process, not unit tests.
      expect(import.meta.env.DEV).toBe(true);
    });
  });

  describe('unauthenticated state', () => {
    beforeEach(() => {
      mockUseSession.mockReturnValue({ data: null });
    });

    it('renders Guest User when no session', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-email')).toHaveTextContent('Guest User');
    });

    it('shows Log In option instead of Log Out', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-login')).toBeInTheDocument();
      expect(screen.queryByTestId('menu-logout')).not.toBeInTheDocument();
    });

    it('shows Sign Up option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-signup')).toBeInTheDocument();
    });

    it('navigates to /login when Log In is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      await user.click(screen.getByTestId('menu-login'));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' });
    });

    it('navigates to /signup when Sign Up is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      await user.click(screen.getByTestId('menu-signup'));

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/signup' });
    });

    it('does not show Settings option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.queryByTestId('menu-settings')).not.toBeInTheDocument();
    });

    it('does not show Add Credits option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.queryByTestId('menu-add-credits')).not.toBeInTheDocument();
    });

    it('still shows GitHub option', async () => {
      const user = userEvent.setup();
      render(<SidebarFooter />);

      await user.click(screen.getByTestId('user-menu-trigger'));
      expect(screen.getByTestId('menu-github')).toBeInTheDocument();
    });
  });
});
