import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEV_PASSWORD, displayUsername, TEST_ID_BUILDERS } from '@hushbox/shared';
import { toast } from '@hushbox/ui';
import { signIn } from '@/lib/auth';
import { renderRoute } from '@/test-utils/render';
import { Route } from './dev.personas';
import type { DevPersona } from '@hushbox/shared';

const { mockNavigate, mockUseSearch, mockToastError } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUseSearch: vi.fn<() => { type?: string }>(),
  mockToastError: vi.fn(),
}));

// Keep the real router (createFileRoute must run for the route file); mock only
// the navigation/search hooks the component uses.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearch: (): { type?: string } => mockUseSearch(),
  };
});

const { mockSignOutAndClearCache } = vi.hoisted(() => ({
  mockSignOutAndClearCache: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/auth', () => ({
  signIn: {
    email: vi.fn(),
  },
  signOutAndClearCache: mockSignOutAndClearCache,
}));

// Keep the real @hushbox/ui (renderRoute needs its providers); override toast.
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    toast: {
      error: mockToastError,
    },
  };
});

vi.mock('@/lib/env', () => ({
  env: { isDev: true },
}));

interface MockDevPersonasReturn {
  data: { personas: DevPersona[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

const mockUseDevPersonas = vi.fn<(type?: 'dev' | 'test') => MockDevPersonasReturn>();
vi.mock('@/hooks/models/dev-personas', () => ({
  useDevPersonas: (type?: 'dev' | 'test'): MockDevPersonasReturn => mockUseDevPersonas(type),
}));

const mockPersonas: DevPersona[] = [
  {
    id: 'user-1',
    username: 'alice_developer',
    email: 'alice@dev.hushbox.ai',
    emailVerified: true,

    stats: { conversationCount: 3, messageCount: 12, projectCount: 2 },
    credits: '$0.00',
  },
  {
    id: 'user-2',
    username: 'bob_tester',
    email: 'bob@dev.hushbox.ai',
    emailVerified: true,

    stats: { conversationCount: 0, messageCount: 0, projectCount: 0 },
    credits: '$0.00',
  },
  {
    id: 'user-3',
    username: 'charlie_unverified',
    email: 'charlie@dev.hushbox.ai',
    emailVerified: false,

    stats: { conversationCount: 0, messageCount: 0, projectCount: 0 },
    credits: '$0.00',
  },
];

describe('PersonasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSearch.mockReturnValue({});
    mockUseDevPersonas.mockReturnValue({
      data: { personas: mockPersonas },
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  describe('loading state', () => {
    it('shows loading indicator when fetching personas', () => {
      mockUseDevPersonas.mockReturnValue({
        data: undefined,
        isLoading: true,
        isError: false,
        error: null,
      });

      renderRoute(Route);

      expect(screen.getByText(/loading personas/i)).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error message when fetch fails', () => {
      mockUseDevPersonas.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        error: new Error('Failed to fetch dev personas'),
      });

      renderRoute(Route);

      expect(screen.getByText(/failed to load personas/i)).toBeInTheDocument();
    });
  });

  describe('personas display', () => {
    it('sizes the page to its container, not the viewport', () => {
      renderRoute(Route);

      // min-h-full, not min-h-dvh: the root route's h-dvh banner-row layout
      // owns the viewport height; the page fills the flex-1 content region
      // below the app-wide banner.
      const page = screen.getByText('Developer Personas').parentElement;
      expect(page).toHaveClass('min-h-full');
    });

    it('renders a card for each persona', () => {
      renderRoute(Route);

      for (const persona of mockPersonas) {
        expect(screen.getByText(displayUsername(persona.username))).toBeInTheDocument();
        expect(screen.getByText(persona.email)).toBeInTheDocument();
      }
    });

    it('renders avatar with first letter of name', () => {
      renderRoute(Route);

      expect(screen.getByText('A')).toBeInTheDocument(); // Alice
      expect(screen.getByText('B')).toBeInTheDocument(); // Bob
      expect(screen.getByText('C')).toBeInTheDocument(); // Charlie
    });

    it('shows verified badge for verified personas', () => {
      renderRoute(Route);

      // Alice and Bob are verified, Charlie is not
      const verifiedBadges = screen.getAllByText('Verified');
      expect(verifiedBadges).toHaveLength(2);

      expect(screen.getByText('Unverified')).toBeInTheDocument();
    });

    it('has data-persona attribute with persona id on each card', () => {
      renderRoute(Route);

      for (const persona of mockPersonas) {
        const emailPrefix = persona.email.split('@')[0] ?? '';
        expect(screen.getByTestId(TEST_ID_BUILDERS.personaCard(emailPrefix))).toHaveAttribute(
          'data-persona',
          persona.id
        );
      }
    });
  });

  describe('stats display', () => {
    it('displays conversation count for each persona', () => {
      renderRoute(Route);

      const aliceCard = screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice'));
      expect(aliceCard).toHaveTextContent('3 conversations');
    });

    it('displays message count for each persona', () => {
      renderRoute(Route);

      const aliceCard = screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice'));
      expect(aliceCard).toHaveTextContent('12 messages');
    });

    it('displays project count for each persona', () => {
      renderRoute(Route);

      const aliceCard = screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice'));
      expect(aliceCard).toHaveTextContent('2 projects');
    });

    it('displays credits for each persona', () => {
      renderRoute(Route);

      const creditElements = screen.getAllByText('$0.00');
      expect(creditElements).toHaveLength(mockPersonas.length);
    });

    it('uses singular form for count of 1', () => {
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

      renderRoute(Route);

      const aliceCard = screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice'));
      expect(aliceCard).toHaveTextContent('1 conversation');
      expect(aliceCard).toHaveTextContent('1 message');
      expect(aliceCard).toHaveTextContent('1 project');
    });
  });

  describe('authentication', () => {
    it('calls signOutAndClearCache before signIn.email on click', async () => {
      vi.mocked(signIn.email).mockResolvedValue({});
      const user = userEvent.setup();

      renderRoute(Route);

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice')));

      expect(mockSignOutAndClearCache).toHaveBeenCalled();
      expect(signIn.email).toHaveBeenCalledWith({
        identifier: 'alice@dev.hushbox.ai',
        password: DEV_PASSWORD,
        keepSignedIn: true,
      });
      const signOutCallOrder = mockSignOutAndClearCache.mock.invocationCallOrder[0];
      const signInCallOrder = vi.mocked(signIn.email).mock.invocationCallOrder[0];
      if (signOutCallOrder === undefined || signInCallOrder === undefined) {
        throw new Error('Call order not recorded');
      }
      expect(signOutCallOrder).toBeLessThan(signInCallOrder);
    });

    it('navigates to /chat on successful login', async () => {
      vi.mocked(signIn.email).mockResolvedValue({});
      const user = userEvent.setup();

      renderRoute(Route);

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice')));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
      });
    });

    it('shows error toast on login failure', async () => {
      vi.mocked(signIn.email).mockResolvedValue({
        error: { message: 'Email not verified' },
      });
      const user = userEvent.setup();

      renderRoute(Route);

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.personaCard('charlie')));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Email not verified');
      });
    });

    it('shows generic error toast when signIn throws network error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(signIn.email).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();

      renderRoute(Route);

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice')));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to switch persona. Please try again.');
      });
      expect(consoleSpy).toHaveBeenCalledWith('Persona login failed:', expect.any(Error));

      consoleSpy.mockRestore();
    });

    it('clears loading state after network error', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(signIn.email).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();

      renderRoute(Route);

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice')));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice'))).toHaveAttribute(
          'aria-busy',
          'false'
        );
      });
    });

    it('shows loading state while authenticating', async () => {
      type ResolveFunction = (value: unknown) => void;
      let resolveSignIn: ResolveFunction | undefined;
      const signInPromise = new Promise((resolve) => {
        resolveSignIn = resolve;
      });
      vi.mocked(signIn.email).mockReturnValue(signInPromise as ReturnType<typeof signIn.email>);

      const user = userEvent.setup();

      renderRoute(Route);

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice')));

      expect(screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice'))).toHaveAttribute(
        'aria-busy',
        'true'
      );

      if (resolveSignIn) resolveSignIn({});

      await waitFor(() => {
        expect(screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice'))).toHaveAttribute(
          'aria-busy',
          'false'
        );
      });
    });

    it('disables all cards while one is loading', async () => {
      type ResolveFunction = (value: unknown) => void;
      let resolveSignIn: ResolveFunction | undefined;
      const signInPromise = new Promise((resolve) => {
        resolveSignIn = resolve;
      });
      vi.mocked(signIn.email).mockReturnValue(signInPromise as ReturnType<typeof signIn.email>);

      const user = userEvent.setup();

      renderRoute(Route);

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.personaCard('alice')));

      for (const persona of mockPersonas) {
        const emailPrefix = persona.email.split('@')[0] ?? '';
        expect(screen.getByTestId(TEST_ID_BUILDERS.personaCard(emailPrefix))).toHaveAttribute(
          'aria-disabled',
          'true'
        );
      }

      if (resolveSignIn) resolveSignIn({});
    });
  });

  it('renders header with title', () => {
    renderRoute(Route);

    expect(screen.getByRole('heading', { name: /developer personas/i })).toBeInTheDocument();
  });

  describe('type query param', () => {
    it('calls useDevPersonas with dev type by default', () => {
      mockUseSearch.mockReturnValue({});

      renderRoute(Route);

      expect(mockUseDevPersonas).toHaveBeenCalledWith('dev');
    });

    it('calls useDevPersonas with test type when ?type=test', () => {
      mockUseSearch.mockReturnValue({ type: 'test' });

      renderRoute(Route);

      expect(mockUseDevPersonas).toHaveBeenCalledWith('test');
    });

    it('shows Test Personas title when type=test', () => {
      mockUseSearch.mockReturnValue({ type: 'test' });

      renderRoute(Route);

      expect(screen.getByRole('heading', { name: /test personas/i })).toBeInTheDocument();
    });

    it('defaults to dev type for invalid type values', () => {
      mockUseSearch.mockReturnValue({ type: 'invalid' });

      renderRoute(Route);

      expect(mockUseDevPersonas).toHaveBeenCalledWith('dev');
    });
  });

  it('shows empty state when no personas', () => {
    mockUseDevPersonas.mockReturnValue({
      data: { personas: [] },
      isLoading: false,
      isError: false,
      error: null,
    });

    renderRoute(Route);

    expect(screen.getByText(/no personas found/i)).toBeInTheDocument();
  });
});
