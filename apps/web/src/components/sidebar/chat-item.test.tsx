import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, ROUTES } from '@hushbox/shared';
import { getEpochKey } from '@/lib/epoch-key-cache';
import { useUIStore } from '@/stores/ui';
import { ChatItem, type SidebarConversation } from './chat-item';

function render(ui: ReactElement): ReturnType<typeof rtlRender> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return rtlRender(ui, { wrapper: Wrapper });
}

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    className,
    onClick,
  }: {
    children: React.ReactNode;
    to: string;
    params?: { id: string };
    className?: string;
    onClick?: () => void;
  }) => (
    <a
      href={params ? to.replace('$id', params.id) : to}
      className={className}
      data-testid="chat-link"
      onClick={onClick}
    >
      {children}
    </a>
  ),
  useNavigate: () => mockNavigate,
}));

const MOCK_ENCRYPTED_BYTES = new Uint8Array([1, 2, 3, 4]);
vi.mock('@hushbox/crypto', () => ({
  encryptTextForEpoch: vi.fn(() => MOCK_ENCRYPTED_BYTES),
  getPublicKeyFromPrivate: vi.fn(() => new Uint8Array([10, 20, 30])),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    toBase64: vi.fn(() => 'bW9jay1lbmNyeXB0ZWQ'),
  };
});

const MOCK_EPOCH_KEY = new Uint8Array([99, 88, 77]);
vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => MOCK_EPOCH_KEY),
  getCurrentEpoch: vi.fn(() => 2),
  processKeyChain: vi.fn(),
}));

vi.mock('@/hooks/crypto/keys', () => ({
  keyChainQueryOptions: vi.fn((conversationId: string) => ({
    queryKey: ['keys', conversationId],
    queryFn: () => Promise.resolve({}),
    staleTime: 0,
  })),
}));

const mockDeleteMutate = vi.fn();
const mockUpdateMutate = vi.fn();

vi.mock('@/hooks/chat/chat', () => ({
  useDeleteConversation: () => ({
    mutate: mockDeleteMutate,
    isPending: false,
  }),
  useUpdateConversation: () => ({
    mutate: mockUpdateMutate,
    isPending: false,
  }),
  DECRYPTING_TITLE: 'Decrypting...',
}));

const mockLeaveMutateAsync = vi.fn(() => Promise.resolve());
const mockMuteMutate = vi.fn();
const mockPinMutate = vi.fn();
vi.mock('@/hooks/realtime/use-conversation-members', () => ({
  useLeaveConversation: () => ({
    mutateAsync: mockLeaveMutateAsync,
    isPending: false,
  }),
  useMuteConversation: () => ({
    mutate: mockMuteMutate,
    isPending: false,
  }),
  usePinConversation: () => ({
    mutate: mockPinMutate,
    isPending: false,
  }),
}));

const mockExecuteWithRotation = vi.fn<(...args: unknown[]) => Promise<void>>(() =>
  Promise.resolve()
);
vi.mock('@/lib/rotation', () => ({
  executeWithRotation: (...args: unknown[]) => mockExecuteWithRotation(...args),
}));

const { authState } = vi.hoisted(() => ({
  authState: {
    user: { id: 'caller-user-id' } as { id: string } | null,
    privateKey: new Uint8Array([7, 7, 7]) as Uint8Array | null,
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuthStore: <T,>(
    selector: (s: { user: { id: string } | null; privateKey: Uint8Array | null }) => T
  ): T => selector(authState),
}));

describe('ChatItem', () => {
  const mockConversation: SidebarConversation = {
    id: 'conv-123',
    title: 'Test Conversation',
    currentEpoch: 2,
    updatedAt: new Date().toISOString(),
    privilege: 'owner',
    muted: false,
    pinned: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMutate.mockClear();
    mockUpdateMutate.mockClear();
    mockLeaveMutateAsync.mockClear();
    mockExecuteWithRotation.mockClear();
    mockNavigate.mockClear();
    mockMuteMutate.mockClear();
    mockPinMutate.mockClear();
    authState.user = { id: 'caller-user-id' };
    authState.privateKey = new Uint8Array([7, 7, 7]);
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
  });

  describe('expanded state', () => {
    it('renders conversation title', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByText('Test Conversation')).toBeInTheDocument();
    });

    it('links to conversation page', () => {
      render(<ChatItem conversation={mockConversation} />);
      const link = screen.getByTestId(TEST_IDS.chatLink);
      expect(link).toHaveAttribute('href', '/chat/conv-123');
    });

    it('truncates long titles', () => {
      const longTitle = {
        ...mockConversation,
        title: 'This is a very long conversation title that should be truncated',
      };
      render(<ChatItem conversation={longTitle} />);
      const title = screen.getByText(longTitle.title);
      expect(title).toHaveClass('truncate');
    });

    it('renders lock icon with muted style when title is Decrypting...', () => {
      const decryptingConversation = { ...mockConversation, title: 'Decrypting...' };
      render(<ChatItem conversation={decryptingConversation} />);
      expect(screen.getByTestId(TEST_IDS.decryptingTitle)).toBeInTheDocument();
      expect(screen.getByText('Decrypting...')).toHaveClass('text-muted-foreground');
    });

    it('hides message icon when expanded', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.queryByTestId(TEST_IDS.messageIcon)).not.toBeInTheDocument();
    });

    it('highlights when active', () => {
      render(<ChatItem conversation={mockConversation} isActive />);
      const link = screen.getByTestId(TEST_IDS.chatLink);
      expect(link.parentElement).toHaveClass('bg-sidebar-border');
    });
  });

  describe('collapsed state', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('shows only icon when collapsed', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByTestId(TEST_IDS.messageIcon)).toBeInTheDocument();
      expect(screen.queryByText('Test Conversation')).not.toBeInTheDocument();
    });

    it('hides more options button when collapsed', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.queryByTestId(TEST_IDS.chatItemMoreButton)).not.toBeInTheDocument();
    });
  });

  describe('actions dropdown', () => {
    it('shows more options button when sidebar is expanded', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByTestId(TEST_IDS.chatItemMoreButton)).toBeInTheDocument();
    });

    it('opens dropdown menu on more button click', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Rename')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('prevents navigation when clicking more button', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      const moreButton = screen.getByTestId(TEST_IDS.chatItemMoreButton);
      await user.click(moreButton);

      expect(screen.getByText('Rename')).toBeInTheDocument();
    });
  });

  describe('delete action', () => {
    it('shows delete confirmation dialog when delete is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Delete'));

      expect(screen.getByText('Delete conversation?')).toBeInTheDocument();
      expect(screen.getByText(/This will permanently delete/)).toBeInTheDocument();
    });

    it('calls delete mutation when confirmed', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId(TEST_IDS.confirmDeleteButton));

      expect(mockDeleteMutate).toHaveBeenCalledWith('conv-123', expect.any(Object));
    });

    it('closes the dialog and navigates home after a successful delete', async () => {
      mockDeleteMutate.mockImplementation(
        (_id: string, options?: { onSuccess?: () => void }): void => {
          options?.onSuccess?.();
        }
      );
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId(TEST_IDS.confirmDeleteButton));

      expect(mockNavigate).toHaveBeenCalledWith({ to: ROUTES.CHAT });
      await waitFor(() => {
        expect(screen.queryByText('Delete conversation?')).not.toBeInTheDocument();
      });
    });

    it('closes dialog when cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId(TEST_IDS.cancelDeleteButton));

      await waitFor(() => {
        expect(screen.queryByText('Delete conversation?')).not.toBeInTheDocument();
      });
      expect(mockDeleteMutate).not.toHaveBeenCalled();
    });
  });

  describe('rename action', () => {
    it('shows rename dialog when rename is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));

      expect(screen.getByText('Rename conversation')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Test Conversation')).toBeInTheDocument();
    });

    it('calls update mutation with encrypted title and titleEpochNumber when saved', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(mockUpdateMutate).toHaveBeenCalledWith(
        {
          conversationId: 'conv-123',
          data: { title: 'bW9jay1lbmNyeXB0ZWQ', titleEpochNumber: 2 },
        },
        expect.any(Object)
      );
    });

    it('closes the rename dialog after a successful update', async () => {
      mockUpdateMutate.mockImplementation(
        (_variables: unknown, options?: { onSuccess?: () => void }): void => {
          options?.onSuccess?.();
        }
      );
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      await waitFor(() => {
        expect(screen.queryByText('Rename conversation')).not.toBeInTheDocument();
      });
    });

    it('does not update when the epoch key is unavailable', async () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- getEpochKey returns undefined for a missing epoch key; that is the case under test
      vi.mocked(getEpochKey).mockReturnValueOnce(undefined);
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(mockUpdateMutate).not.toHaveBeenCalled();
    });

    it('closes dialog when cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      await user.click(screen.getByTestId(TEST_IDS.cancelRenameButton));

      await waitFor(() => {
        expect(screen.queryByText('Rename conversation')).not.toBeInTheDocument();
      });
      expect(mockUpdateMutate).not.toHaveBeenCalled();
    });

    it('disables save button when title is empty', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);

      expect(screen.getByTestId(TEST_IDS.saveRenameButton)).toBeDisabled();
    });
  });

  describe('non-owner actions', () => {
    const nonOwnerConversation: SidebarConversation = {
      ...mockConversation,
      privilege: 'write',
    };

    it('shows Leave instead of Rename and Delete for non-owner', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Leave')).toBeInTheDocument();
      expect(screen.queryByText('Rename')).not.toBeInTheDocument();
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('shows Leave for read privilege', async () => {
      const user = userEvent.setup();
      render(
        <ChatItem
          conversation={{ ...mockConversation, privilege: 'read' } satisfies SidebarConversation}
        />
      );

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Leave')).toBeInTheDocument();
      expect(screen.queryByText('Rename')).not.toBeInTheDocument();
    });

    it('shows Leave for admin privilege', async () => {
      const user = userEvent.setup();
      render(
        <ChatItem
          conversation={{ ...mockConversation, privilege: 'admin' } satisfies SidebarConversation}
        />
      );

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Leave')).toBeInTheDocument();
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('opens leave confirmation modal when Leave is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
    });

    it('routes non-owner leave through executeWithRotation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

      await waitFor(() => {
        expect(mockExecuteWithRotation).toHaveBeenCalledOnce();
      });
      // The contract: the rotation generator receives the conversation id,
      // the cached epoch key + number, the plaintext title (so the new epoch
      // can re-encrypt it), a filter that excludes the leaving user, and an
      // execute callback that issues the API request.
      expect(mockExecuteWithRotation).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-123',
          currentEpochPrivateKey: MOCK_EPOCH_KEY,
          currentEpochNumber: 2,
          plaintextTitle: 'Test Conversation',
          filterMembers: expect.any(Function),
          execute: expect.any(Function),
        })
      );
    });

    it('does not call any leave path when cancelled', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationCancel));

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.leaveConfirmationModal)).not.toBeInTheDocument();
      });
      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      expect(mockLeaveMutateAsync).not.toHaveBeenCalled();
    });

    it('refuses to leave without an authenticated user', async () => {
      authState.user = null;
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

      await waitFor(() => {
        expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      });
      expect(mockLeaveMutateAsync).not.toHaveBeenCalled();
    });

    it('refuses to leave without an unlocked account key', async () => {
      authState.privateKey = null;
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

      await waitFor(() => {
        expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      });
      expect(mockLeaveMutateAsync).not.toHaveBeenCalled();
    });

    it('navigates to /chat when leaving the active conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} isActive />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
      });
    });

    it('does not navigate when leaving a non-active conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

      // Wait for the leave action to settle, then assert no navigation
      await waitFor(() => {
        expect(mockExecuteWithRotation).toHaveBeenCalledOnce();
      });
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('shows Rename and Delete for owner privilege', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Rename')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
      expect(screen.queryByText('Leave')).not.toBeInTheDocument();
    });
  });

  describe('mute action', () => {
    it('shows Mute option for unmuted conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Mute')).toBeInTheDocument();
      expect(screen.queryByText('Unmute')).not.toBeInTheDocument();
    });

    it('shows Unmute option for muted conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, muted: true }} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Unmute')).toBeInTheDocument();
      expect(screen.queryByText('Mute')).not.toBeInTheDocument();
    });

    it('calls mute mutation when Mute is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Mute'));

      expect(mockMuteMutate).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        muted: true,
      });
    });

    it('calls unmute mutation when Unmute is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, muted: true }} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Unmute'));

      expect(mockMuteMutate).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        muted: false,
      });
    });

    it('shows Mute option for non-owner members', async () => {
      const user = userEvent.setup();
      render(
        <ChatItem
          conversation={{ ...mockConversation, privilege: 'write' } satisfies SidebarConversation}
        />
      );

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Mute')).toBeInTheDocument();
    });
  });

  describe('pin action', () => {
    it('shows Pin option for unpinned conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Pin')).toBeInTheDocument();
      expect(screen.queryByText('Unpin')).not.toBeInTheDocument();
    });

    it('shows Unpin option for pinned conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, pinned: true }} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Unpin')).toBeInTheDocument();
      expect(screen.queryByText('Pin')).not.toBeInTheDocument();
    });

    it('calls pin mutation when Pin is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Pin'));

      expect(mockPinMutate).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        pinned: true,
      });
    });

    it('calls unpin mutation when Unpin is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, pinned: true }} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Unpin'));

      expect(mockPinMutate).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        pinned: false,
      });
    });

    it('shows Pin option for non-owner members', async () => {
      const user = userEvent.setup();
      render(
        <ChatItem
          conversation={{ ...mockConversation, privilege: 'write' } satisfies SidebarConversation}
        />
      );

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Pin')).toBeInTheDocument();
    });
  });
});
