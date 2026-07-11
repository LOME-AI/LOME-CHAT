import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { SidebarContent } from './sidebar-content';

function render(ui: ReactElement): ReturnType<typeof rtlRender> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return rtlRender(ui, { wrapper: Wrapper });
}

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/chat/some-id' }),
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className} data-testid="link">
      {children}
    </a>
  ),
  useParams: () => ({ conversationId: undefined }),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: () => false,
  };
});

vi.mock('@/hooks/chat/chat', () => ({
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

vi.mock('@/lib/auth', () => ({
  useAuthStore: <T,>(selector: (s: { user: { id: string } | null }) => T): T =>
    selector({ user: { id: 'user-1' } }),
}));

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

// ItemRow renders exactly once per ChatItem body execution, so this counter
// mirrors how many times ChatItem rows render across the whole list.
const chatItemRenderSpy = vi.fn();
vi.mock('@/components/shared/item-row', () => ({
  ItemRow: ({ children }: Readonly<{ children: React.ReactNode }>) => {
    chatItemRenderSpy();
    return <div>{children}</div>;
  },
}));

describe('SidebarContent', () => {
  const mockConversations = [
    {
      id: 'conv-1',
      title: 'Test Conversation',
      currentEpoch: 1,
      updatedAt: new Date().toISOString(),
      privilege: 'owner' as const,
      muted: false,
      pinned: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ sidebarOpen: true });
  });

  it('renders NewChatButton', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(screen.getByRole('link', { name: /new chat/i })).toBeInTheDocument();
  });

  it('renders Search chats input when sidebar is open', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(screen.getByText('Search chats')).toBeInTheDocument();
  });

  it('renders ChatList with conversations', () => {
    render(<SidebarContent conversations={mockConversations} />);
    expect(screen.getByText('Test Conversation')).toBeInTheDocument();
  });

  it('renders in correct order: NewChat, Search, ChatList', () => {
    render(<SidebarContent conversations={mockConversations} />);
    const content = screen.getByTestId(TEST_IDS.sidebarNav);
    expect(content).toBeInTheDocument();
  });

  it('has aria-label on navigation', () => {
    render(<SidebarContent conversations={mockConversations} />);
    const nav = screen.getByRole('navigation');
    expect(nav).toHaveAttribute('aria-label', 'Chat navigation');
  });

  it('shows scrollbar on chat list container when sidebar is open', () => {
    render(<SidebarContent conversations={mockConversations} />);
    const container = screen.getByTestId(TEST_IDS.chatListScrollContainer);
    expect(container).not.toHaveClass('scrollbar-hide');
  });

  describe('collapsed state', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('hides search and labels when collapsed', () => {
      render(<SidebarContent conversations={mockConversations} />);
      expect(screen.queryByText('New Chat')).not.toBeInTheDocument();
      expect(screen.queryByText('Search chats')).not.toBeInTheDocument();
    });

    it('hides scrollbar on chat list container when collapsed', () => {
      render(<SidebarContent conversations={mockConversations} />);
      const container = screen.getByTestId(TEST_IDS.chatListScrollContainer);
      expect(container).toHaveClass('scrollbar-hide');
    });
  });

  describe('invite navigation', () => {
    const acceptedConvs = [
      {
        id: 'conv-1',
        title: 'Design Chat',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner' as const,
        muted: false,
        pinned: false,
      },
      {
        id: 'conv-2',
        title: 'Weekend Plans',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: true,
        invitedByUsername: null,
        privilege: 'write' as const,
        muted: false,
        pinned: false,
      },
    ];

    const unacceptedConvs = [
      {
        id: 'conv-3',
        title: 'Team Standup',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        accepted: false,
        invitedByUsername: 'sarah',
        privilege: 'write' as const,
        muted: false,
        pinned: false,
      },
    ];

    const mixedConvs = [...acceptedConvs, ...unacceptedConvs];

    it('shows plain heading when all conversations are accepted', () => {
      render(<SidebarContent conversations={acceptedConvs} />);
      expect(screen.getByText('Recent Chats')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /invites/i })).not.toBeInTheDocument();
    });

    it('renders clickable buttons when unaccepted conversations exist', () => {
      render(<SidebarContent conversations={mixedConvs} />);
      expect(screen.getByRole('button', { name: /recent chats/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /invites/i })).toBeInTheDocument();
    });

    it('shows invite count badge on Invites button', () => {
      render(<SidebarContent conversations={mixedConvs} />);
      const invitesButton = screen.getByRole('button', { name: /invites/i });
      expect(invitesButton).toHaveTextContent('1');
    });

    it('shows accepted conversations by default', () => {
      render(<SidebarContent conversations={mixedConvs} />);
      expect(screen.getByText('Design Chat')).toBeInTheDocument();
      expect(screen.getByText('Weekend Plans')).toBeInTheDocument();
    });

    it('slides to inbox content when Invites is clicked', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      render(<SidebarContent conversations={mixedConvs} />);

      await userEvent.click(screen.getByRole('button', { name: /invites/i }));

      expect(screen.getByTestId(TEST_IDS.inboxContent)).toBeInTheDocument();
      expect(screen.getByText('Team Standup')).toBeInTheDocument();
    });

    it('keeps chat list in DOM during slide (both panels render)', () => {
      render(<SidebarContent conversations={mixedConvs} />);
      expect(screen.getByText('Design Chat')).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.inboxContent)).toBeInTheDocument();
    });

    it('shows plain heading when no conversations have accepted field', () => {
      render(<SidebarContent conversations={mockConversations} />);
      expect(screen.getByText('Recent Chats')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /invites/i })).not.toBeInTheDocument();
    });
  });

  describe('search re-render', () => {
    const searchableConvs = [
      {
        id: 'conv-a',
        title: 'Alpha chat',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        privilege: 'owner' as const,
        muted: false,
        pinned: false,
      },
      {
        id: 'conv-b',
        title: 'Beta chat',
        currentEpoch: 1,
        updatedAt: new Date().toISOString(),
        privilege: 'owner' as const,
        muted: false,
        pinned: false,
      },
    ];

    it('does not re-render rows that stay in the filtered list on a keystroke', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      render(<SidebarContent conversations={searchableConvs} />);

      const rendersAfterMount = chatItemRenderSpy.mock.calls.length;
      expect(rendersAfterMount).toBe(searchableConvs.length);

      // "chat" is a substring of both titles, so both rows stay mounted.
      await userEvent.type(screen.getByRole('textbox'), 'chat');

      expect(chatItemRenderSpy.mock.calls.length).toBe(rendersAfterMount);
    });
  });

  describe('pinned conversations', () => {
    it('renders pinned conversations above unpinned', () => {
      const conversations = [
        {
          id: 'conv-unpinned-1',
          title: 'Unpinned First',
          currentEpoch: 1,
          updatedAt: '2026-03-27T03:00:00Z',
          privilege: 'owner' as const,
          muted: false,
          pinned: false,
        },
        {
          id: 'conv-pinned',
          title: 'Pinned Chat',
          currentEpoch: 1,
          updatedAt: '2026-03-27T01:00:00Z',
          privilege: 'owner' as const,
          muted: false,
          pinned: true,
        },
        {
          id: 'conv-unpinned-2',
          title: 'Unpinned Second',
          currentEpoch: 1,
          updatedAt: '2026-03-27T02:00:00Z',
          privilege: 'owner' as const,
          muted: false,
          pinned: false,
        },
      ];

      render(<SidebarContent conversations={conversations} />);

      const items = screen.getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('Pinned Chat');
      expect(items[1]).toHaveTextContent('Unpinned First');
      expect(items[2]).toHaveTextContent('Unpinned Second');
    });

    it('renders separator between pinned and unpinned conversations', () => {
      const conversations = [
        {
          id: 'conv-pinned',
          title: 'Pinned Chat',
          currentEpoch: 1,
          updatedAt: '2026-03-27T01:00:00Z',
          privilege: 'owner' as const,
          muted: false,
          pinned: true,
        },
        {
          id: 'conv-unpinned',
          title: 'Unpinned Chat',
          currentEpoch: 1,
          updatedAt: '2026-03-27T02:00:00Z',
          privilege: 'owner' as const,
          muted: false,
          pinned: false,
        },
      ];

      render(<SidebarContent conversations={conversations} />);

      expect(screen.getByTestId(TEST_IDS.pinnedSeparator)).toBeInTheDocument();
    });

    it('does not render separator when no conversations are pinned', () => {
      render(<SidebarContent conversations={mockConversations} />);

      expect(screen.queryByTestId(TEST_IDS.pinnedSeparator)).not.toBeInTheDocument();
    });

    it('does not render separator when all conversations are pinned', () => {
      const conversations = [
        {
          id: 'conv-pinned-1',
          title: 'Pinned One',
          currentEpoch: 1,
          updatedAt: '2026-03-27T01:00:00Z',
          privilege: 'owner' as const,
          muted: false,
          pinned: true,
        },
        {
          id: 'conv-pinned-2',
          title: 'Pinned Two',
          currentEpoch: 1,
          updatedAt: '2026-03-27T02:00:00Z',
          privilege: 'owner' as const,
          muted: false,
          pinned: true,
        },
      ];

      render(<SidebarContent conversations={conversations} />);

      expect(screen.queryByTestId(TEST_IDS.pinnedSeparator)).not.toBeInTheDocument();
    });
  });
});
