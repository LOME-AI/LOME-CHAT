import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEV_PASSWORD } from '@lome-chat/shared';
import type { DevPersona } from '@lome-chat/shared';
import { signIn } from '@/lib/auth';
import { toast } from '@lome-chat/ui';

class RedirectError extends Error {
  to: string;
  isRedirect: boolean;
  constructor(to: string) {
    super(`Redirect to ${to}`);
    this.to = to;
    this.isRedirect = true;
  }
}

const mockNavigate = vi.fn();
const mockUseSearch = vi.fn<() => { type?: string }>();
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => vi.fn()),
  useNavigate: vi.fn(() => mockNavigate),
  redirect: vi.fn((opts: { to: string }) => {
    throw new RedirectError(opts.to);
  }),
  useSearch: (): { type?: string } => mockUseSearch(),
}));

const { mockSignOutAndClearCache } = vi.hoisted(() => ({
  mockSignOutAndClearCache: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/auth', () => ({
  signIn: {
    email: vi.fn(),
  },
  signOutAndClearCache: mockSignOutAndClearCache,
}));

vi.mock('@lome-chat/ui', () => ({
  toast: {
    error: vi.fn(),
  },
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

interface MockDevPersonasReturn {
  data: { personas: DevPersona[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

const mockUseDevPersonas = vi.fn<(type?: 'dev' | 'test') => MockDevPersonasReturn>();
vi.mock('@/hooks/dev-personas', () => ({
  useDevPersonas: (type?: 'dev' | 'test'): MockDevPersonasReturn => mockUseDevPersonas(type),
}));

const mockPersonas: DevPersona[] = [
  {
    id: 'user-1',
    name: 'Alice Developer',
    email: 'alice@dev.lome-chat.com',
    emailVerified: true,
    image: null,
    stats: { conversationCount: 3, messageCount: 12, projectCount: 2 },
    credits: '$0.00',
  },
  {
    id: 'user-2',
    name: 'Bob Tester',
    email: 'bob@dev.lome-chat.com',
    emailVerified: true,
    image: null,
    stats: { conversationCount: 0, messageCount: 0, projectCount: 0 },
    credits: '$0.00',
  },
  {
    id: 'user-3',
    name: 'Charlie Unverified',
    email: 'charlie@dev.lome-chat.com',
    emailVerified: false,
    image: null,
    stats: { conversationCount: 0, messageCount: 0, projectCount: 0 },
    credits: '$0.00',
  },
];

describe('PersonasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to no query param (dev personas)
    mockUseSearch.mockReturnValue({});
    // Default to successful load
    mockUseDevPersonas.mockReturnValue({
      data: { personas: mockPersonas },
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  describe('loading state', () => {
    it('shows loading indicator when fetching personas', async () => {
      mockUseDevPersonas.mockReturnValue({
        data: undefined,
        isLoading: true,
        isError: false,
        error: null,
      });

      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      expect(screen.getByText(/loading personas/i)).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error message when fetch fails', async () => {
      mockUseDevPersonas.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        error: new Error('Failed to fetch dev personas'),
      });

      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      expect(screen.getByText(/failed to load personas/i)).toBeInTheDocument();
    });
  });

  describe('personas display', () => {
    it('renders a card for each persona', async () => {
      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      for (const persona of mockPersonas) {
        expect(screen.getByText(persona.name)).toBeInTheDocument();
        expect(screen.getByText(persona.email)).toBeInTheDocument();
      }
    });

    it('renders avatar with first letter of name', async () => {
      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      expect(screen.getByText('A')).toBeInTheDocument(); // Alice
      expect(screen.getByText('B')).toBeInTheDocument(); // Bob
      expect(screen.getByText('C')).toBeInTheDocument(); // Charlie
    });

    it('shows verified badge for verified personas', async () => {
      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      // Alice and Bob are verified, Charlie is not
      const verifiedBadges = screen.getAllByText('Verified');
      expect(verifiedBadges).toHaveLength(2);

      expect(screen.getByText('Unverified')).toBeInTheDocument();
    });

    it('has data-persona attribute with persona id on each card', async () => {
      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      for (const persona of mockPersonas) {
        const emailPrefix = persona.email.split('@')[0] ?? '';
        expect(screen.getByTestId(`persona-card-${emailPrefix}`)).toHaveAttribute(
          'data-persona',
          persona.id
        );
      }
    });
  });

  describe('stats display', () => {
    it('displays conversation count for each persona', async () => {
      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      // Alice has 3 conversations
      const aliceCard = screen.getByTestId('persona-card-alice');
      expect(aliceCard).toHaveTextContent('3 conversations');
    });

    it('displays message count for each persona', async () => {
      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      // Alice has 12 messages
      const aliceCard = screen.getByTestId('persona-card-alice');
      expect(aliceCard).toHaveTextContent('12 messages');
    });

    it('displays project count for each persona', async () => {
      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      // Alice has 2 projects
      const aliceCard = screen.getByTestId('persona-card-alice');
      expect(aliceCard).toHaveTextContent('2 projects');
    });

    it('displays credits for each persona', async () => {
      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      // All personas show $0.00
      const creditElements = screen.getAllByText('$0.00');
      expect(creditElements).toHaveLength(mockPersonas.length);
    });

    it('uses singular form for count of 1', async () => {
      const persona = mockPersonas[0];
      if (!persona) throw new Error('Test data missing');
      mockUseDevPersonas.mockReturnValue({
        data: {
          personas: [
            {
              ...persona,
              stats: { conversationCount: 1, messageCount: 1, projectCount: 1 },
            },
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      });

      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      const aliceCard = screen.getByTestId('persona-card-alice');
      expect(aliceCard).toHaveTextContent('1 conversation');
      expect(aliceCard).toHaveTextContent('1 message');
      expect(aliceCard).toHaveTextContent('1 project');
    });
  });

  describe('authentication', () => {
    it('calls signOutAndClearCache before signIn.email on click', async () => {
      vi.mocked(signIn.email).mockResolvedValue({ data: {}, error: null });
      const user = userEvent.setup();
      const { PersonasPage } = await import('./dev.personas');

      render(<PersonasPage />);

      await user.click(screen.getByTestId('persona-card-alice'));

      // Verify signOutAndClearCache is called first
      expect(mockSignOutAndClearCache).toHaveBeenCalled();
      expect(signIn.email).toHaveBeenCalledWith({
        email: 'alice@dev.lome-chat.com',
        password: DEV_PASSWORD,
      });
      // Verify order: signOutAndClearCache before signIn
      const signOutCallOrder = mockSignOutAndClearCache.mock.invocationCallOrder[0];
      const signInCallOrder = vi.mocked(signIn.email).mock.invocationCallOrder[0];
      if (signOutCallOrder === undefined || signInCallOrder === undefined) {
        throw new Error('Call order not recorded');
      }
      expect(signOutCallOrder).toBeLessThan(signInCallOrder);
    });

    it('navigates to /chat on successful login', async () => {
      vi.mocked(signIn.email).mockResolvedValue({ data: {}, error: null });
      const user = userEvent.setup();
      const { PersonasPage } = await import('./dev.personas');

      render(<PersonasPage />);

      await user.click(screen.getByTestId('persona-card-alice'));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
      });
    });

    it('shows error toast on login failure', async () => {
      vi.mocked(signIn.email).mockResolvedValue({
        data: null,
        error: { message: 'Email not verified' },
      });
      const user = userEvent.setup();
      const { PersonasPage } = await import('./dev.personas');

      render(<PersonasPage />);

      await user.click(screen.getByTestId('persona-card-charlie'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Email not verified');
      });
    });

    it('shows generic error toast when signIn throws network error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(signIn.email).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      const { PersonasPage } = await import('./dev.personas');

      render(<PersonasPage />);

      await user.click(screen.getByTestId('persona-card-alice'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to switch persona. Please try again.');
      });
      expect(consoleSpy).toHaveBeenCalledWith('Persona login failed:', expect.any(Error));

      consoleSpy.mockRestore();
    });

    it('clears loading state after network error', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.mocked(signIn.email).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      const { PersonasPage } = await import('./dev.personas');

      render(<PersonasPage />);

      await user.click(screen.getByTestId('persona-card-alice'));

      await waitFor(() => {
        expect(screen.getByTestId('persona-card-alice')).toHaveAttribute('aria-busy', 'false');
      });
    });

    it('shows loading state while authenticating', async () => {
      type ResolveFunc = (value: unknown) => void;
      let resolveSignIn: ResolveFunc | undefined;
      const signInPromise = new Promise((resolve) => {
        resolveSignIn = resolve;
      });
      vi.mocked(signIn.email).mockReturnValue(signInPromise as ReturnType<typeof signIn.email>);

      const user = userEvent.setup();
      const { PersonasPage } = await import('./dev.personas');

      render(<PersonasPage />);

      await user.click(screen.getByTestId('persona-card-alice'));

      expect(screen.getByTestId('persona-card-alice')).toHaveAttribute('aria-busy', 'true');

      if (resolveSignIn) resolveSignIn({ data: {}, error: null });

      await waitFor(() => {
        expect(screen.getByTestId('persona-card-alice')).toHaveAttribute('aria-busy', 'false');
      });
    });

    it('disables all cards while one is loading', async () => {
      type ResolveFunc = (value: unknown) => void;
      let resolveSignIn: ResolveFunc | undefined;
      const signInPromise = new Promise((resolve) => {
        resolveSignIn = resolve;
      });
      vi.mocked(signIn.email).mockReturnValue(signInPromise as ReturnType<typeof signIn.email>);

      const user = userEvent.setup();
      const { PersonasPage } = await import('./dev.personas');

      render(<PersonasPage />);

      await user.click(screen.getByTestId('persona-card-alice'));

      for (const persona of mockPersonas) {
        const emailPrefix = persona.email.split('@')[0] ?? '';
        expect(screen.getByTestId(`persona-card-${emailPrefix}`)).toHaveAttribute(
          'aria-disabled',
          'true'
        );
      }

      if (resolveSignIn) resolveSignIn({ data: {}, error: null });
    });
  });

  it('renders header with title', async () => {
    const { PersonasPage } = await import('./dev.personas');

    render(<PersonasPage />);

    expect(screen.getByRole('heading', { name: /developer personas/i })).toBeInTheDocument();
  });

  describe('type query param', () => {
    it('calls useDevPersonas with dev type by default', async () => {
      mockUseSearch.mockReturnValue({});

      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      expect(mockUseDevPersonas).toHaveBeenCalledWith('dev');
    });

    it('calls useDevPersonas with test type when ?type=test', async () => {
      mockUseSearch.mockReturnValue({ type: 'test' });

      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      expect(mockUseDevPersonas).toHaveBeenCalledWith('test');
    });

    it('shows Test Personas title when type=test', async () => {
      mockUseSearch.mockReturnValue({ type: 'test' });

      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      expect(screen.getByRole('heading', { name: /test personas/i })).toBeInTheDocument();
    });

    it('defaults to dev type for invalid type values', async () => {
      mockUseSearch.mockReturnValue({ type: 'invalid' });

      const { PersonasPage } = await import('./dev.personas');
      render(<PersonasPage />);

      expect(mockUseDevPersonas).toHaveBeenCalledWith('dev');
    });
  });

  it('shows empty state when no personas', async () => {
    mockUseDevPersonas.mockReturnValue({
      data: { personas: [] },
      isLoading: false,
      isError: false,
      error: null,
    });

    const { PersonasPage } = await import('./dev.personas');
    render(<PersonasPage />);

    expect(screen.getByText(/no personas found/i)).toBeInTheDocument();
  });
});
