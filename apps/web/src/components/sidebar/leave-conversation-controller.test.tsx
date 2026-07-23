import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { TouchDeviceOverrideContext } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { ChatList } from './chat-list';
import { LeaveConversationProvider, useRequestLeave } from './leave-conversation-controller';
import type { SidebarConversation } from './chat-item';

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

vi.mock('@hushbox/crypto', () => ({
  encryptTextForEpoch: vi.fn(() => new Uint8Array([1, 2, 3, 4])),
  getPublicKeyFromPrivate: vi.fn(() => new Uint8Array([10, 20, 30])),
}));

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

vi.mock('@/hooks/chat/chat', () => ({
  useDeleteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  DECRYPTING_TITLE: 'Decrypting...',
}));

const mockLeaveMutateAsync = vi.fn(() => Promise.resolve());
vi.mock('@/hooks/realtime/use-conversation-members', () => ({
  useLeaveConversation: () => ({ mutateAsync: mockLeaveMutateAsync, isPending: false }),
  useMuteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  usePinConversation: () => ({ mutate: vi.fn(), isPending: false }),
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

const nonOwnerConversation: SidebarConversation = {
  id: 'conv-123',
  title: 'Group Chat',
  currentEpoch: 2,
  updatedAt: new Date().toISOString(),
  privilege: 'write',
  muted: false,
  pinned: false,
};

function Harness({
  conversations,
  touch = true,
}: Readonly<{ conversations: SidebarConversation[]; touch?: boolean }>): React.JSX.Element {
  return (
    <TouchDeviceOverrideContext value={touch}>
      <LeaveConversationProvider>
        <ChatList conversations={conversations} />
      </LeaveConversationProvider>
    </TouchDeviceOverrideContext>
  );
}

function render(ui: ReactElement): ReturnType<typeof rtlRender> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return rtlRender(ui, { wrapper: Wrapper });
}

describe('LeaveConversationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 'caller-user-id' };
    authState.privateKey = new Uint8Array([7, 7, 7]);
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
  });

  it('keeps the confirmation modal mounted when the row that opened it is removed', async () => {
    // The bug: on a touch device, confirming a leave drops the conversation
    // from the sidebar list, which unmounts the ChatItem. If that row owned the
    // modal, the modal unmounts mid-close and vaul leaves its portal stuck. The
    // modal must be owned by this stable provider, so removing the row leaves it
    // in the DOM to close cleanly.
    const user = userEvent.setup();
    const { rerender } = render(<Harness conversations={[nonOwnerConversation]} />);

    await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
    await user.click(screen.getByText('Leave'));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
    });

    // Simulate the post-leave list invalidation dropping the row.
    rerender(<Harness conversations={[]} />);

    expect(screen.queryByText('Group Chat')).not.toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
  });

  it('runs the leave flow and closes the modal on confirm', async () => {
    // Non-touch (Radix dialog) so the close reliably unmounts the portal in
    // jsdom; the touch-device stuck-portal case is the iphone-15 e2e oracle.
    const user = userEvent.setup();
    render(<Harness conversations={[nonOwnerConversation]} touch={false} />);

    await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
    await user.click(screen.getByText('Leave'));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

    await waitFor(() => {
      expect(mockExecuteWithRotation).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.leaveConfirmationModal)).not.toBeInTheDocument();
    });
  });

  it('throws when requestLeave is used without a provider', () => {
    const { result } = renderHook(() => useRequestLeave());
    expect(() => {
      result.current(nonOwnerConversation, false);
    }).toThrow(/LeaveConversationProvider/);
  });
});
