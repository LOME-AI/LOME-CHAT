import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: vi.fn(),
  useDeleteConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  DECRYPTING_TITLE: 'Decrypting...',
  chatKeys: {
    all: ['chat'] as const,
    conversations: () => ['chat', 'conversations'] as const,
    conversation: (id: string) => ['chat', 'conversations', id] as const,
    messages: (conversationId: string) =>
      ['chat', 'conversations', conversationId, 'messages'] as const,
  },
}));

import { useDecryptedConversations } from '@/hooks/chat/chat';

const mockUseDecryptedConversations = vi.mocked(useDecryptedConversations);

function mockConversationsHook(
  overrides?: Partial<ReturnType<typeof useDecryptedConversations>>
): void {
  mockUseDecryptedConversations.mockReturnValue({
    data: [],
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    ...overrides,
  });
}

vi.mock('@/hooks/realtime/use-conversation-members', () => ({
  useAcceptMembership: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useLeaveConversation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(() => Promise.resolve()),
    isPending: false,
  }),
  useDeclineInvitation: () => ({
    mutateAsync: vi.fn(() => Promise.resolve()),
    isPending: false,
  }),
  useMuteConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  usePinConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(() => ({
    data: {
      user: { id: 'user-1', email: 'test@example.com', username: 'test_user' },
      session: { id: 'session-1' },
    },
    isPending: false,
  })),
  useAuthStore: <T,>(selector: (s: { user: { id: string } | null }) => T): T =>
    selector({ user: { id: 'user-1' } }),
  signOutAndClearCache: vi.fn(),
}));

import { useSession } from '@/lib/auth';
import { Sidebar } from './sidebar';
import type { ReactNode } from 'react';

const mockUseSession = vi.mocked(useSession);

const useParamsMock = vi.fn<() => { id: string | undefined }>(() => ({ id: undefined }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' }),
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    params?: { id: string };
    className?: string;
  }) => (
    <a
      href={params ? to.replace('$id', params.id) : to}
      className={className}
      data-testid="chat-link"
    >
      {children}
    </a>
  ),
  useParams: () => useParamsMock(),
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

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: vi.fn(() => false),
  };
});

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

const testConv = {
  id: 'conv-1',
  userId: 'user-1',
  title: 'Test Chat',
  currentEpoch: 1,
  titleEpochNumber: 1,
  nextSequence: 1,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  accepted: true,
  invitedByUsername: null,
  privilege: 'owner' as const,
  muted: false,
  pinned: false,
};

describe('Sidebar', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true });
    useParamsMock.mockReturnValue({ id: undefined });
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: 'user-1',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
        },
        session: { id: 'session-1' },
      },
      isPending: false,
    });
    mockConversationsHook({ data: [testConv] });
  });

  describe('desktop view', () => {
    it('renders aside element', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByRole('complementary')).toBeInTheDocument();
    });

    it('renders sidebar header', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId(TEST_IDS.sidebarHeader)).toBeInTheDocument();
    });

    it('renders SidebarFooter', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId(TEST_IDS.sidebarFooter)).toBeInTheDocument();
    });

    it('has w-72 class when sidebar is open', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('w-72');
    });

    it('has w-12 class when sidebar is collapsed (rail mode)', () => {
      useUIStore.setState({ sidebarOpen: false });
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('w-12');
    });

    it('uses sidebar background color', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('bg-sidebar');
    });

    it('uses sidebar border color', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside.className).toContain('border-r');
    });

    it('uses sidebar foreground color', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('text-sidebar-foreground');
    });

    it('has transition class for smooth animation', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('transition-[width]');
    });

    it('has right border', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      const aside = screen.getByRole('complementary');
      expect(aside).toHaveClass('border-r');
    });
  });

  describe('content area', () => {
    it('renders SidebarContent navigation', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId(TEST_IDS.sidebarNav)).toBeInTheDocument();
    });

    it('renders NewChatButton', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByRole('link', { name: /new chat/i })).toBeInTheDocument();
    });

    it('renders Search chats input', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByText('Search chats')).toBeInTheDocument();
    });
  });

  describe('data fetching', () => {
    it('calls useDecryptedConversations hook', () => {
      render(<Sidebar />, { wrapper: createWrapper() });
      expect(mockUseDecryptedConversations).toHaveBeenCalled();
    });

    it('shows decrypting state with lock icon when fetching', () => {
      mockConversationsHook({ data: undefined, isLoading: true });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId(TEST_IDS.decryptingIndicator)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.decryptingLockIcon)).toBeInTheDocument();
      expect(screen.getByText('Decrypting...')).toBeInTheDocument();
    });

    it('shows only lock icon without text when collapsed and loading', () => {
      useUIStore.setState({ sidebarOpen: false });
      mockConversationsHook({ data: undefined, isLoading: true });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByTestId(TEST_IDS.decryptingLockIcon)).toBeInTheDocument();
      expect(screen.queryByText('Decrypting...')).not.toBeInTheDocument();
    });

    it('shows empty state when no conversations', () => {
      mockConversationsHook();

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    });

    it('displays conversations from hook', () => {
      mockConversationsHook({
        data: [
          { ...testConv, title: 'First Chat' },
          {
            ...testConv,
            id: 'conv-2',
            title: 'Second Chat',
            privilege: 'write',
            createdAt: '2024-01-02',
            updatedAt: '2024-01-02',
          },
        ],
      });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByText('First Chat')).toBeInTheDocument();
      expect(screen.getByText('Second Chat')).toBeInTheDocument();
    });
  });

  describe('session expiry', () => {
    it('does not render conversations when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockConversationsHook({ data: [{ ...testConv, title: 'Stale Chat' }] });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.queryByText('Stale Chat')).not.toBeInTheDocument();
    });

    it('does not show Decrypting indicator when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockConversationsHook({ data: undefined, isLoading: true });

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.queryByText('Decrypting...')).not.toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.decryptingIndicator)).not.toBeInTheDocument();
    });

    it('shows NewChatButton when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockConversationsHook();

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByRole('link', { name: /new chat/i })).toBeInTheDocument();
    });

    it('shows signup message when session is null', () => {
      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockConversationsHook();

      render(<Sidebar />, { wrapper: createWrapper() });
      expect(screen.getByText('Sign up')).toBeInTheDocument();
      expect(screen.getByText(/to save conversations/)).toBeInTheDocument();
    });

    it('clears conversations query cache when session becomes unauthenticated', () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(
        ['chat', 'conversations'],
        [
          {
            id: 'conv-1',
            userId: 'user-1',
            title: 'Cached Chat',
            currentEpoch: 1,
            titleEpochNumber: 1,
            nextSequence: 1,
            createdAt: '2024-01-01',
            updatedAt: '2024-01-01',
            accepted: true,
            invitedByUsername: null,
            privilege: 'owner',
            muted: false,
            pinned: false,
          },
        ]
      );

      mockUseSession.mockReturnValue({
        data: null,
        isPending: false,
      });
      mockConversationsHook({ data: undefined });

      function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
      }
      Wrapper.displayName = 'TestWrapper';

      render(<Sidebar />, { wrapper: Wrapper });

      const cachedData = queryClient.getQueryData(['chat', 'conversations']);
      expect(cachedData).toBeUndefined();
    });
  });

  describe('active conversation highlight', () => {
    const conversations = [
      { ...testConv, id: 'conv-1', title: 'First Chat' },
      { ...testConv, id: 'conv-2', title: 'Second Chat' },
    ];

    it('highlights the row matching the router-derived conversation id', () => {
      useParamsMock.mockReturnValue({ id: 'conv-2' });
      mockConversationsHook({ data: conversations });

      render(<Sidebar />, { wrapper: createWrapper() });

      const activeRow = screen
        .getByText('Second Chat')
        .closest('[data-testid="chat-link"]')?.parentElement;
      const inactiveRow = screen
        .getByText('First Chat')
        .closest('[data-testid="chat-link"]')?.parentElement;
      expect(activeRow).toHaveClass('bg-sidebar-border');
      expect(inactiveRow).not.toHaveClass('bg-sidebar-border');
    });

    it('highlights no row when not on a conversation route', () => {
      useParamsMock.mockReturnValue({ id: undefined });
      mockConversationsHook({ data: conversations });

      render(<Sidebar />, { wrapper: createWrapper() });

      const firstRow = screen
        .getByText('First Chat')
        .closest('[data-testid="chat-link"]')?.parentElement;
      const secondRow = screen
        .getByText('Second Chat')
        .closest('[data-testid="chat-link"]')?.parentElement;
      expect(firstRow).not.toHaveClass('bg-sidebar-border');
      expect(secondRow).not.toHaveClass('bg-sidebar-border');
    });
  });
});
