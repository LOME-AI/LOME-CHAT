import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { MemberSidebar } from '@/components/chat/member/member-sidebar';

const {
  mockCloseMemberSidebar,
  mockSetMemberSidebarOpen,
  mockMemberSidebarOpen,
  mockUseConversationBudgets,
} = vi.hoisted(() => ({
  mockCloseMemberSidebar: vi.fn(),
  mockSetMemberSidebarOpen: vi.fn(),
  mockMemberSidebarOpen: { value: true },
  mockUseConversationBudgets: vi.fn(),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: vi.fn(() => false),
  };
});

vi.mock('@/stores/ui-modals', () => ({
  // Invoke the passed selector (from `useShallow`) against a stub state so the
  // component's real selector body runs, rather than returning a fixed object.
  useUIModalsStore: vi.fn((selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      memberSidebarOpen: mockMemberSidebarOpen.value,
      mobileMemberSidebarOpen: mockMemberSidebarOpen.value,
      closeMemberSidebar: mockCloseMemberSidebar,
      setMemberSidebarOpen: mockSetMemberSidebarOpen,
      setMobileMemberSidebarOpen: vi.fn(),
    };
    return typeof selector === 'function' ? selector(state) : state;
  }),
}));

vi.mock('@/hooks/billing/use-conversation-budgets', () => ({
  useConversationBudgets: mockUseConversationBudgets,
}));

function makeMembers(): {
  id: string;
  userId: string;
  username: string;
  privilege: string;
}[] {
  return [
    { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
    { id: 'm2', userId: 'u2', username: 'bob', privilege: 'admin' },
    { id: 'm3', userId: 'u3', username: 'charlie', privilege: 'write' },
    { id: 'm4', userId: 'u4', username: 'dave', privilege: 'read' },
  ];
}

function makeLinks(): {
  id: string;
  displayName: string | null;
  privilege: string;
  createdAt: string;
}[] {
  return [
    {
      id: 'link1',
      displayName: 'Dave',
      privilege: 'read',
      createdAt: '2026-02-08T00:00:00Z',
    },
    {
      id: 'link2',
      displayName: null,
      privilege: 'write',
      createdAt: '2026-02-07T00:00:00Z',
    },
  ];
}

const defaultProps = {
  members: makeMembers(),
  links: makeLinks(),
  onlineMemberIds: new Set(['u1', 'u2']),
  currentUserId: 'u1',
  currentUserPrivilege: 'owner',
  conversationId: 'conv-123',
  onRemoveMember: vi.fn(),
  onChangePrivilege: vi.fn(),
  onRevokeLinkClick: vi.fn(),
  onSaveLinkName: vi.fn(),
  onChangeLinkPrivilege: vi.fn(),
  onBudgetSettingsClick: vi.fn(),
  onLeaveClick: vi.fn(),
  onAddMember: vi.fn(),
  onInviteLink: vi.fn(),
};

describe('MemberSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMemberSidebarOpen.value = true;
    mockUseConversationBudgets.mockReturnValue({ data: undefined, isLoading: false });

    let portalTarget = document.querySelector('#right-sidebar-portal');
    if (!portalTarget) {
      portalTarget = document.createElement('div');
      portalTarget.id = 'right-sidebar-portal';
      portalTarget.className = 'contents';
      document.body.append(portalTarget);
    }
  });

  afterEach(() => {
    const portalTarget = document.querySelector('#right-sidebar-portal');
    if (portalTarget) {
      portalTarget.remove();
    }
  });

  describe('header', () => {
    it('renders MEMBERS (N) title matching Logo font style', () => {
      render(<MemberSidebar {...defaultProps} />);

      const title = screen.getByText('MEMBERS (4)');
      expect(title).toBeInTheDocument();
      expect(title).toHaveClass('text-primary');
      expect(title).toHaveClass('text-lg');
      expect(title).toHaveClass('font-bold');
    });

    it('renders header icon for members', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-sidebar-header-icon')).toBeInTheDocument();
    });

    it('renders close button in header', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByLabelText('Close sidebar')).toBeInTheDocument();
    });

    it('toggles sidebar closed when close button is clicked on desktop', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByLabelText('Close sidebar'));

      expect(mockSetMemberSidebarOpen).toHaveBeenCalledWith(false);
    });
  });

  describe('action buttons', () => {
    it('renders New Member button when canManageMembers is true', () => {
      render(<MemberSidebar {...defaultProps} currentUserPrivilege="owner" />);

      expect(screen.getByTestId('new-member-button')).toBeInTheDocument();
    });

    it('renders Invite via Link button when canManageMembers is true', () => {
      render(<MemberSidebar {...defaultProps} currentUserPrivilege="owner" />);

      expect(screen.getByTestId('invite-link-button')).toBeInTheDocument();
    });

    it('hides New Member button for non-admin users', () => {
      render(<MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />);

      expect(screen.queryByTestId('new-member-button')).not.toBeInTheDocument();
    });

    it('hides Invite via Link button for non-admin users', () => {
      render(<MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />);

      expect(screen.queryByTestId('invite-link-button')).not.toBeInTheDocument();
    });

    it('calls onAddMember when New Member button is clicked', async () => {
      const onAddMember = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onAddMember={onAddMember} />);

      await user.click(screen.getByTestId('new-member-button'));

      expect(onAddMember).toHaveBeenCalledOnce();
    });

    it('calls onInviteLink when Invite via Link button is clicked', async () => {
      const onInviteLink = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onInviteLink={onInviteLink} />);

      await user.click(screen.getByTestId('invite-link-button'));

      expect(onInviteLink).toHaveBeenCalledOnce();
    });
  });

  describe('search', () => {
    it('renders search input', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-search-input')).toBeInTheDocument();
    });

    it('filters members by username (case-insensitive)', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.type(screen.getByTestId('member-search-input'), 'ali');

      expect(screen.getByTestId('member-item-m1')).toBeInTheDocument();
      expect(screen.queryByTestId('member-item-m2')).not.toBeInTheDocument();
      expect(screen.queryByTestId('member-item-m3')).not.toBeInTheDocument();
      expect(screen.queryByTestId('member-item-m4')).not.toBeInTheDocument();
    });

    it('normalizes search query with uppercase letters', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.type(screen.getByTestId('member-search-input'), 'Ali');

      expect(screen.getByTestId('member-item-m1')).toBeInTheDocument();
      expect(screen.queryByTestId('member-item-m2')).not.toBeInTheDocument();
    });

    it('shows all members when search is cleared', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.type(screen.getByTestId('member-search-input'), 'ali');
      await user.clear(screen.getByTestId('member-search-input'));

      expect(screen.getByTestId('member-item-m1')).toBeInTheDocument();
      expect(screen.getByTestId('member-item-m2')).toBeInTheDocument();
      expect(screen.getByTestId('member-item-m3')).toBeInTheDocument();
      expect(screen.getByTestId('member-item-m4')).toBeInTheDocument();
    });
  });

  describe('member grouping', () => {
    it('groups members by privilege level', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-section-owner')).toBeInTheDocument();
      expect(screen.getByTestId('member-section-admin')).toBeInTheDocument();
      expect(screen.getByTestId('member-section-write')).toBeInTheDocument();
      expect(screen.getByTestId('member-section-read')).toBeInTheDocument();
    });

    it('shows (you) badge for current user', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-you-badge')).toBeInTheDocument();
      const aliceItem = screen.getByTestId('member-item-m1');
      expect(aliceItem).toHaveTextContent('(you)');
    });

    it('shows (you) badge for current link guest', () => {
      render(<MemberSidebar {...defaultProps} currentUserLinkId="link1" />);

      expect(screen.getByTestId('link-you-badge')).toBeInTheDocument();
      const linkItem = screen.getByTestId('link-item-link1');
      expect(linkItem).toHaveTextContent('(you)');
    });

    it('shows online indicator for online members', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm1'))).toBeInTheDocument();
      expect(screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm2'))).toBeInTheDocument();
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm3'))
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm4'))
      ).not.toBeInTheDocument();
    });
  });

  describe('member row dropdown menu', () => {
    it('shows three-dots button for current user (Leave action available)', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-actions-m1')).toBeInTheDocument();
    });

    it('shows three-dots button for other members when admin+', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-actions-m2')).toBeInTheDocument();
      expect(screen.getByTestId('member-actions-m3')).toBeInTheDocument();
      expect(screen.getByTestId('member-actions-m4')).toBeInTheDocument();
    });

    it('hides three-dots for other members when user is not admin', () => {
      render(<MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />);

      expect(screen.getByTestId('member-actions-m3')).toBeInTheDocument();
      expect(screen.queryByTestId('member-actions-m1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('member-actions-m2')).not.toBeInTheDocument();
      expect(screen.queryByTestId('member-actions-m4')).not.toBeInTheDocument();
    });

    it('hides three-dots for current user when onLeaveClick is undefined', () => {
      render(
        <MemberSidebar
          {...defaultProps}
          currentUserId="u3"
          currentUserPrivilege="write"
          onLeaveClick={undefined}
        />
      );

      expect(screen.queryByTestId('member-actions-m3')).not.toBeInTheDocument();
    });

    it('shows Leave in current user dropdown', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m1'));
      await waitFor(() => {
        expect(screen.getByTestId('member-leave-action')).toBeInTheDocument();
      });
    });

    it('opens leave confirmation modal when Leave is selected from dropdown', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m1'));
      await waitFor(() => {
        expect(screen.getByTestId('member-leave-action')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-leave-action'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-modal')).toBeInTheDocument();
      });
    });

    it('calls onLeaveClick when leave is confirmed from dropdown menu', async () => {
      const onLeaveClick = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onLeaveClick={onLeaveClick} />);

      await user.click(screen.getByTestId('member-actions-m1'));
      await waitFor(() => {
        expect(screen.getByTestId('member-leave-action')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-leave-action'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-modal')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('leave-confirmation-confirm'));

      expect(onLeaveClick).toHaveBeenCalledOnce();
    });

    it('shows Change Privilege submenu for other members when admin+', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-change-privilege-m2')).toBeInTheDocument();
      });
    });

    it('shows Remove Member action for other members when admin+', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-remove-action-m2')).toBeInTheDocument();
      });
    });

    it('opens confirmation modal when Remove Member is clicked', async () => {
      const onRemoveMember = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onRemoveMember={onRemoveMember} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-remove-action-m2')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-remove-action-m2'));

      // Should not call directly — opens modal instead
      expect(onRemoveMember).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.getByTestId('remove-member-modal')).toBeInTheDocument();
      });
    });

    it('calls onChangePrivilege when a privilege option is selected', async () => {
      const onChangePrivilege = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onChangePrivilege={onChangePrivilege} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('privilege-option-m2-write')).toBeInTheDocument();
      });
      // Flat radio group inside the main dropdown — no sub-menu hop.
      fireEvent.click(screen.getByTestId('privilege-option-m2-write'));

      expect(onChangePrivilege).toHaveBeenCalledWith('m2', 'write');
    });

    it('does not show owner in privilege options', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('privilege-option-m2-write')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('privilege-option-m2-owner')).not.toBeInTheDocument();
      expect(screen.getByTestId('privilege-option-m2-admin')).toBeInTheDocument();
      expect(screen.getByTestId('privilege-option-m2-write')).toBeInTheDocument();
      expect(screen.getByTestId('privilege-option-m2-read')).toBeInTheDocument();
    });
  });

  describe('confirmation modals', () => {
    it('shows confirmation modal when Remove Member is clicked', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-remove-action-m2')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-remove-action-m2'));

      await waitFor(() => {
        expect(screen.getByTestId('remove-member-modal')).toBeInTheDocument();
      });
      expect(screen.getByTestId('remove-member-title')).toHaveTextContent('Remove Bob?');
    });

    it('calls onRemoveMember only after confirmation', async () => {
      const onRemoveMember = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onRemoveMember={onRemoveMember} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-remove-action-m2')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-remove-action-m2'));

      // Not called yet — just opened the modal
      expect(onRemoveMember).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.getByTestId('remove-member-confirm')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('remove-member-confirm'));

      expect(onRemoveMember).toHaveBeenCalledWith('m2');
    });

    it('does not call onRemoveMember when cancel is clicked', async () => {
      const onRemoveMember = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onRemoveMember={onRemoveMember} />);

      await user.click(screen.getByTestId('member-actions-m2'));
      await waitFor(() => {
        expect(screen.getByTestId('member-remove-action-m2')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-remove-action-m2'));

      await waitFor(() => {
        expect(screen.getByTestId('remove-member-cancel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('remove-member-cancel'));

      expect(onRemoveMember).not.toHaveBeenCalled();
    });

    it('shows confirmation modal when Revoke Link is clicked', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-revoke-action-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-revoke-action-link1'));

      await waitFor(() => {
        expect(screen.getByTestId('revoke-link-modal')).toBeInTheDocument();
      });
      expect(screen.getByTestId('revoke-link-title')).toHaveTextContent('Revoke Dave?');
    });

    it('calls onRevokeLinkClick only after confirmation', async () => {
      const onRevokeLinkClick = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onRevokeLinkClick={onRevokeLinkClick} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-revoke-action-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-revoke-action-link1'));

      expect(onRevokeLinkClick).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(screen.getByTestId('revoke-link-confirm')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('revoke-link-confirm'));

      expect(onRevokeLinkClick).toHaveBeenCalledWith('link1');
    });

    it('does not call onRevokeLinkClick when cancel is clicked', async () => {
      const onRevokeLinkClick = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onRevokeLinkClick={onRevokeLinkClick} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-revoke-action-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-revoke-action-link1'));

      await waitFor(() => {
        expect(screen.getByTestId('revoke-link-cancel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('revoke-link-cancel'));

      expect(onRevokeLinkClick).not.toHaveBeenCalled();
    });
  });

  describe('link integration', () => {
    it('renders links in read section alongside read members', () => {
      render(<MemberSidebar {...defaultProps} />);

      const readSection = screen.getByTestId('member-section-read');
      expect(readSection).toContainElement(screen.getByTestId('member-item-m4'));
      expect(readSection).toContainElement(screen.getByTestId('link-item-link1'));
    });

    it('renders links in write section alongside write members', () => {
      render(<MemberSidebar {...defaultProps} />);

      const writeSection = screen.getByTestId('member-section-write');
      expect(writeSection).toContainElement(screen.getByTestId('member-item-m3'));
      expect(writeSection).toContainElement(screen.getByTestId('link-item-link2'));
    });

    it('does not render a separate Guest Links section', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.queryByText('Guest Links')).not.toBeInTheDocument();
    });

    it('does not show privilege text next to link names', () => {
      render(<MemberSidebar {...defaultProps} />);

      const linkItem = screen.getByTestId('link-item-link1');
      expect(linkItem).not.toHaveTextContent('(read)');
    });

    it('renders link items with display name', () => {
      render(<MemberSidebar {...defaultProps} />);

      const linkItem = screen.getByTestId('link-item-link1');
      expect(linkItem).toHaveTextContent('Dave');
    });

    it('shows fallback name for links without display name', () => {
      render(<MemberSidebar {...defaultProps} />);

      const linkItem = screen.getByTestId('link-item-link2');
      expect(linkItem).toHaveTextContent('Guest Link #2');
    });

    it('search filters links by display name', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.type(screen.getByTestId('member-search-input'), 'dave');

      expect(screen.getByTestId('link-item-link1')).toBeInTheDocument();
      expect(screen.queryByTestId('link-item-link2')).not.toBeInTheDocument();
    });

    it('link text aligns with member text (size-8 icon container)', () => {
      render(<MemberSidebar {...defaultProps} />);

      const linkItem = screen.getByTestId('link-item-link1');
      const iconContainer = linkItem.querySelector('[data-testid="link-icon-container"]');
      expect(iconContainer).toHaveClass('size-8');
    });
  });

  describe('link dropdown menu', () => {
    it('shows three-dot button for links when admin', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('link-actions-link1')).toBeInTheDocument();
      expect(screen.getByTestId('link-actions-link2')).toBeInTheDocument();
    });

    it('hides three-dot button for links when non-admin', () => {
      render(<MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />);

      expect(screen.queryByTestId('link-actions-link1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('link-actions-link2')).not.toBeInTheDocument();
    });

    it('shows privilege options for links with read/write options', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-privilege-option-link1-read')).toBeInTheDocument();
      });

      expect(screen.getByTestId('link-privilege-option-link1-write')).toBeInTheDocument();
      expect(screen.queryByTestId('link-privilege-option-link1-admin')).not.toBeInTheDocument();
      expect(screen.queryByTestId('link-privilege-option-link1-owner')).not.toBeInTheDocument();
    });

    it('calls onChangeLinkPrivilege when privilege option is selected for link', async () => {
      const onChangeLinkPrivilege = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onChangeLinkPrivilege={onChangeLinkPrivilege} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-privilege-option-link1-write')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('link-privilege-option-link1-write'));

      expect(onChangeLinkPrivilege).toHaveBeenCalledWith('link1', 'write');
    });

    it('shows Change Name option in link dropdown', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-change-name-link1')).toBeInTheDocument();
      });
    });

    it('shows Revoke Link option in link dropdown', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-revoke-action-link1')).toBeInTheDocument();
      });
    });
  });

  describe('inline edit', () => {
    it('enters inline edit mode when Change Name is selected', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-change-name-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-change-name-link1'));

      await waitFor(() => {
        expect(screen.getByTestId('link-name-input-link1')).toBeInTheDocument();
      });
    });

    it('saves name on Enter key', async () => {
      const onSaveLinkName = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onSaveLinkName={onSaveLinkName} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-change-name-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-change-name-link1'));

      await waitFor(() => {
        expect(screen.getByTestId('link-name-input-link1')).toBeInTheDocument();
      });

      const input = screen.getByTestId('link-name-input-link1');
      await user.clear(input);
      await user.type(input, 'New Name{Enter}');

      expect(onSaveLinkName).toHaveBeenCalledWith('link1', 'New Name');
    });

    it('cancels edit on Escape key', async () => {
      const onSaveLinkName = vi.fn();
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onSaveLinkName={onSaveLinkName} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await waitFor(() => {
        expect(screen.getByTestId('link-change-name-link1')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('link-change-name-link1'));

      await waitFor(() => {
        expect(screen.getByTestId('link-name-input-link1')).toBeInTheDocument();
      });

      await user.type(screen.getByTestId('link-name-input-link1'), '{Escape}');

      expect(screen.queryByTestId('link-name-input-link1')).not.toBeInTheDocument();
      expect(onSaveLinkName).not.toHaveBeenCalled();
    });
  });

  describe('footer', () => {
    it('renders budget footer with SidebarFooterBase', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-budget-footer')).toBeInTheDocument();
    });

    it('shows Budget Settings label for admin+ users', () => {
      render(<MemberSidebar {...defaultProps} currentUserPrivilege="owner" />);

      expect(screen.getByText('Budget Settings')).toBeInTheDocument();
    });

    it('shows Your Budget label for non-admin users', () => {
      render(<MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />);

      expect(screen.getByText('Your Budget')).toBeInTheDocument();
    });

    it('calls onBudgetSettingsClick when footer trigger is clicked', async () => {
      const user = userEvent.setup();
      const onBudgetSettingsClick = vi.fn();
      render(<MemberSidebar {...defaultProps} onBudgetSettingsClick={onBudgetSettingsClick} />);

      await user.click(screen.getByTestId('member-budget-trigger'));

      expect(onBudgetSettingsClick).toHaveBeenCalled();
    });

    it('shows budget sublabel when data is available', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationSpentNanoUsd: '10000000000',
          ownerBalanceNanoUsd: '200000000000',
          members: [],
        },
        isLoading: false,
      });

      render(<MemberSidebar {...defaultProps} />);

      // Owner: spent = total conversation spend ($10.00), budget = owner balance ($200.00)
      expect(screen.getByText('$10.00 spent / $200.00 budget')).toBeInTheDocument();
    });

    it('shows $0.00 sublabel when the owner has spent nothing', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationSpentNanoUsd: '0',
          ownerBalanceNanoUsd: '100000000000',
          members: [],
        },
        isLoading: false,
      });

      render(<MemberSidebar {...defaultProps} />);

      // Owner: spent = $0.00, budget = owner balance = $100.00
      expect(screen.getByText('$0.00 spent / $100.00 budget')).toBeInTheDocument();
    });

    it('shows the owner balance as budget regardless of member rows', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationSpentNanoUsd: '0',
          ownerBalanceNanoUsd: '50000000000',
          members: [],
        },
        isLoading: false,
      });

      render(<MemberSidebar {...defaultProps} />);

      // Owner: spent = $0.00, budget = owner balance = $50.00
      expect(screen.getByText('$0.00 spent / $50.00 budget')).toBeInTheDocument();
    });

    it('shows effective budget for non-owner members', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationSpentNanoUsd: '30000000000',
          ownerBalanceNanoUsd: '200000000000',
          members: [
            {
              memberId: 'm3',
              userId: 'u3',
              spentNanoUsd: '15000000000',
              effectiveRemainingNanoUsd: '35000000000',
            },
          ],
        },
        isLoading: false,
      });

      render(<MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />);

      // Member: spent = $15.00, budget = backend effective remaining = $35.00
      expect(screen.getByText('$15.00 spent / $35.00 budget')).toBeInTheDocument();
    });

    it('matches the member row by memberId for link guests', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationSpentNanoUsd: '20000000000',
          ownerBalanceNanoUsd: '200000000000',
          members: [
            {
              memberId: 'link-abc',
              userId: null,
              spentNanoUsd: '5000000000',
              effectiveRemainingNanoUsd: '35000000000',
            },
          ],
        },
      });

      // A link guest is identified by their member id (the response carries no linkId).
      render(
        <MemberSidebar {...defaultProps} currentUserId="link-abc" currentUserPrivilege="write" />
      );

      // Guest: spent = $5.00, budget = backend effective remaining = $35.00
      expect(screen.getByText('$5.00 spent / $35.00 budget')).toBeInTheDocument();
    });

    it('shows $0.00 budget for a link guest whose effective remaining is zero', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationSpentNanoUsd: '10000000000',
          ownerBalanceNanoUsd: '200000000000',
          members: [
            {
              memberId: 'link-abc',
              userId: null,
              spentNanoUsd: '0',
              effectiveRemainingNanoUsd: '0',
            },
          ],
        },
      });

      render(
        <MemberSidebar {...defaultProps} currentUserId="link-abc" currentUserPrivilege="write" />
      );

      expect(screen.getByText('$0.00 spent / $0.00 budget')).toBeInTheDocument();
    });

    it('shows $0.00 for a non-owner with no matching budget row', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationSpentNanoUsd: '10000000000',
          ownerBalanceNanoUsd: '200000000000',
          members: [
            {
              memberId: 'other-member',
              userId: 'other-user',
              spentNanoUsd: '10000000000',
              effectiveRemainingNanoUsd: '40000000000',
            },
          ],
        },
      });

      render(
        <MemberSidebar
          {...defaultProps}
          currentUserId="link-no-match"
          currentUserPrivilege="write"
        />
      );

      // No matching row → spent $0.00, budget $0.00
      expect(screen.getByText('$0.00 spent / $0.00 budget')).toBeInTheDocument();
    });

    it('shows owner warning in leave confirmation modal from dropdown', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} currentUserPrivilege="owner" />);

      await user.click(screen.getByTestId('member-actions-m1'));
      await waitFor(() => {
        expect(screen.getByTestId('member-leave-action')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-leave-action'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-warning')).toHaveTextContent(
          'delete all messages'
        );
      });
    });

    it('shows non-owner warning in leave confirmation modal from dropdown', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} currentUserId="u3" currentUserPrivilege="write" />);

      await user.click(screen.getByTestId('member-actions-m3'));
      await waitFor(() => {
        expect(screen.getByTestId('member-leave-action')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('member-leave-action'));

      await waitFor(() => {
        expect(screen.getByTestId('leave-confirmation-warning')).toHaveTextContent('lose access');
      });
    });
  });

  describe('link-guest members (null userId/username)', () => {
    // A link guest reaching the members list carries null userId/username; the
    // rows must render a fallback instead of throwing in displayUsername(null).
    function membersWithGuest(): {
      id: string;
      userId: string | null;
      username: string | null;
      privilege: string;
    }[] {
      return [
        { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
        { id: 'guest', userId: null, username: null, privilege: 'read' },
      ];
    }

    it('renders a null-username guest row without throwing and shows the Guest fallback', () => {
      expect(() =>
        render(<MemberSidebar {...defaultProps} members={membersWithGuest()} />)
      ).not.toThrow();
      const guestRow = screen.getByTestId('member-item-guest');
      expect(guestRow).toHaveTextContent('Guest');
      // Real member keeps their normal display name.
      expect(screen.getByTestId('member-item-m1')).toHaveTextContent('Alice');
    });

    it('treats a null-userId guest as offline (no online indicator)', () => {
      render(
        <MemberSidebar
          {...defaultProps}
          members={membersWithGuest()}
          onlineMemberIds={new Set(['u1'])}
        />
      );
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.onlineFor('member', 'guest'))
      ).not.toBeInTheDocument();
      // The real online member still shows the indicator.
      expect(screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member', 'm1'))).toBeInTheDocument();
    });

    it('renders the collapsed guest avatar with a fallback initial without throwing', () => {
      mockMemberSidebarOpen.value = false;
      expect(() =>
        render(<MemberSidebar {...defaultProps} members={membersWithGuest()} />)
      ).not.toThrow();
      expect(screen.getByTestId('member-avatar-guest')).toHaveTextContent('?');
    });

    it('does not throw when searching with a null-username guest present', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} members={membersWithGuest()} />);
      await user.type(screen.getByTestId('member-search-input'), 'ali');
      expect(screen.getByTestId('member-item-m1')).toBeInTheDocument();
      expect(screen.queryByTestId('member-item-guest')).not.toBeInTheDocument();
    });
  });

  describe('desktop rendering', () => {
    it('renders as aside element on desktop', () => {
      render(<MemberSidebar {...defaultProps} />);

      const sidebar = screen.getByTestId('member-sidebar');
      expect(sidebar).toBeInTheDocument();
      expect(sidebar.tagName).toBe('ASIDE');
    });

    it('has w-72 class on desktop when expanded', () => {
      render(<MemberSidebar {...defaultProps} />);

      const sidebar = screen.getByTestId('member-sidebar');
      expect(sidebar).toHaveClass('w-72');
    });

    it('renders into portal target on desktop', () => {
      render(<MemberSidebar {...defaultProps} />);

      const portalTarget = document.querySelector('#right-sidebar-portal');
      expect(portalTarget).toContainElement(screen.getByTestId('member-sidebar'));
    });

    it('has overflow-hidden on content container to prevent page-level scroll', () => {
      render(<MemberSidebar {...defaultProps} />);

      const content = screen.getByTestId('member-sidebar-content');
      expect(content).toHaveClass('overflow-hidden');
    });
  });

  describe('collapsed state', () => {
    beforeEach(() => {
      mockMemberSidebarOpen.value = false;
    });

    it('renders w-12 rail when collapsed', () => {
      render(<MemberSidebar {...defaultProps} />);

      const sidebar = screen.getByTestId('member-sidebar');
      expect(sidebar).toHaveClass('w-12');
    });

    it('shows icon-only action buttons when collapsed and admin', () => {
      render(<MemberSidebar {...defaultProps} />);

      const newMemberButton = screen.getByTestId('new-member-button');
      expect(newMemberButton).toBeInTheDocument();
      expect(newMemberButton).toHaveAttribute('aria-label', 'New Member');
    });

    it('shows member avatar circles when collapsed', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-avatar-m1')).toBeInTheDocument();
      expect(screen.getByTestId('member-avatar-m2')).toBeInTheDocument();
      expect(screen.getByTestId('member-avatar-m3')).toBeInTheDocument();
      expect(screen.getByTestId('member-avatar-m4')).toBeInTheDocument();
    });

    it('shows member initials in avatars', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-avatar-m1')).toHaveTextContent('A');
    });

    it('hides search input when collapsed', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.queryByTestId('member-search-input')).not.toBeInTheDocument();
    });

    it('hides member privilege groups when collapsed', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.queryByTestId('member-section-owner')).not.toBeInTheDocument();
    });

    it('limits avatars to 8 and shows overflow count', () => {
      const manyMembers = Array.from({ length: 10 }, (_, index) => ({
        id: `m${String(index + 1)}`,
        userId: `u${String(index + 1)}`,
        username: `user${String(index + 1)}`,
        privilege: 'write',
      }));
      render(<MemberSidebar {...defaultProps} members={manyMembers} />);

      expect(screen.getByTestId('member-overflow-count')).toHaveTextContent('+2');
    });

    it('does not show overflow count when 8 or fewer members', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(screen.queryByTestId('member-overflow-count')).not.toBeInTheDocument();
    });

    it('hides scrollbar on collapsed content container', () => {
      render(<MemberSidebar {...defaultProps} />);
      const content = screen.getByTestId('member-sidebar-content');
      expect(content).toHaveClass('scrollbar-hide');
    });

    it('expands sidebar when expand button is clicked in collapsed state', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByLabelText('Expand sidebar'));

      expect(mockSetMemberSidebarOpen).toHaveBeenCalledWith(true);
    });

    it('shows online indicator on collapsed avatars', () => {
      render(<MemberSidebar {...defaultProps} />);

      expect(
        screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member-avatar', 'm1'))
      ).toBeInTheDocument();
      expect(
        screen.getByTestId(TEST_ID_BUILDERS.onlineFor('member-avatar', 'm2'))
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.onlineFor('member-avatar', 'm3'))
      ).not.toBeInTheDocument();
    });
  });

  describe('loading state', () => {
    it('renders Decrypting... placeholder with lock icon when no data props are provided', () => {
      render(<MemberSidebar />);

      expect(screen.getByTestId('decrypting-indicator')).toBeInTheDocument();
      expect(screen.getByTestId('decrypting-lock-icon')).toBeInTheDocument();
      expect(screen.getByText('Decrypting...')).toBeInTheDocument();
    });

    it('shows only lock icon without text when collapsed and loading', () => {
      mockMemberSidebarOpen.value = false;
      render(<MemberSidebar />);

      expect(screen.getByTestId('decrypting-lock-icon')).toBeInTheDocument();
      expect(screen.queryByText('Decrypting...')).not.toBeInTheDocument();
    });

    it('renders sidebar shell even without data', () => {
      render(<MemberSidebar />);

      const sidebar = screen.getByTestId('member-sidebar');
      expect(sidebar).toBeInTheDocument();
      expect(sidebar.tagName).toBe('ASIDE');
    });

    it('shows MEMBERS title without count when loading', () => {
      render(<MemberSidebar />);

      expect(screen.getByText('MEMBERS')).toBeInTheDocument();
      expect(screen.queryByText(/MEMBERS \(/)).not.toBeInTheDocument();
    });

    it('does not render member content when loading', () => {
      render(<MemberSidebar />);

      expect(screen.queryByTestId('member-sidebar-content')).not.toBeInTheDocument();
    });

    it('does not render footer when loading', () => {
      render(<MemberSidebar />);

      expect(screen.queryByTestId('member-budget-footer')).not.toBeInTheDocument();
    });

    it('renders content when currentUserId is empty string (guest)', () => {
      render(<MemberSidebar {...defaultProps} currentUserId="" currentUserPrivilege="read" />);

      expect(screen.getByTestId('member-sidebar-content')).toBeInTheDocument();
      expect(screen.queryByText('Decrypting...')).not.toBeInTheDocument();
      expect(screen.queryByTestId('decrypting-indicator')).not.toBeInTheDocument();
    });

    it('does not show (you) badge when currentUserId is empty string', () => {
      render(<MemberSidebar {...defaultProps} currentUserId="" currentUserPrivilege="read" />);

      expect(screen.queryByTestId('member-you-badge')).not.toBeInTheDocument();
    });
  });

  describe('mobile rendering', () => {
    it('renders inside Sheet on mobile', async () => {
      const module_ = await import('@hushbox/ui');
      vi.mocked(module_.useIsMobile).mockReturnValue(true);

      render(<MemberSidebar {...defaultProps} />);

      expect(screen.getByTestId('member-sidebar-content')).toBeInTheDocument();
    });

    it('closes the mobile sheet when the close button is clicked', async () => {
      const setMobileMemberSidebarOpen = vi.fn();
      const module_ = await import('@hushbox/ui');
      vi.mocked(module_.useIsMobile).mockReturnValue(true);
      const storeModule = await import('@/stores/ui-modals');
      vi.mocked(storeModule.useUIModalsStore).mockReturnValue({
        memberSidebarOpen: true,
        mobileMemberSidebarOpen: true,
        closeMemberSidebar: mockCloseMemberSidebar,
        setMemberSidebarOpen: mockSetMemberSidebarOpen,
        setMobileMemberSidebarOpen,
      });
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} />);

      await user.click(screen.getByLabelText('Close sidebar'));

      expect(setMobileMemberSidebarOpen).toHaveBeenCalledWith(false);
    });
  });

  describe('conversation switching', () => {
    it('clears the search query when conversationId changes', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<MemberSidebar {...defaultProps} conversationId="conv-A" />);

      await user.type(screen.getByTestId('member-search-input'), 'ali');
      expect(screen.getByTestId('member-search-input')).toHaveValue('ali');

      rerender(<MemberSidebar {...defaultProps} conversationId="conv-B" />);

      expect(screen.getByTestId('member-search-input')).toHaveValue('');
    });

    it('keeps the search query when conversationId is unchanged across rerenders', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<MemberSidebar {...defaultProps} conversationId="conv-A" />);

      await user.type(screen.getByTestId('member-search-input'), 'ali');
      rerender(<MemberSidebar {...defaultProps} conversationId="conv-A" />);

      expect(screen.getByTestId('member-search-input')).toHaveValue('ali');
    });
  });

  describe('omitted callbacks', () => {
    it('renders rows without crashing when mutation callbacks are omitted', async () => {
      const user = userEvent.setup();
      render(
        <MemberSidebar
          {...defaultProps}
          onChangePrivilege={undefined}
          onSaveLinkName={undefined}
          onChangeLinkPrivilege={undefined}
          onRemoveMember={undefined}
          onRevokeLinkClick={undefined}
        />
      );

      // Member remove confirm with onRemoveMember omitted closes the modal
      // without throwing (optional-chaining no-op path).
      await user.click(screen.getByTestId('member-actions-m2'));
      await user.click(await screen.findByTestId('member-remove-action-m2'));
      await user.click(await screen.findByTestId('remove-member-confirm'));

      await waitFor(() => {
        expect(screen.queryByTestId('remove-member-modal')).not.toBeInTheDocument();
      });
    });

    it('closes the revoke modal without throwing when onRevokeLinkClick is omitted', async () => {
      const user = userEvent.setup();
      render(<MemberSidebar {...defaultProps} onRevokeLinkClick={undefined} />);

      await user.click(screen.getByTestId('link-actions-link1'));
      await user.click(await screen.findByTestId('link-revoke-action-link1'));
      await user.click(await screen.findByTestId('revoke-link-confirm'));

      await waitFor(() => {
        expect(screen.queryByTestId('revoke-link-modal')).not.toBeInTheDocument();
      });
    });

    it('does not render the budget footer add/invite when callbacks omitted (no crash)', () => {
      render(
        <MemberSidebar
          {...defaultProps}
          onAddMember={undefined}
          onInviteLink={undefined}
          onBudgetSettingsClick={undefined}
        />
      );

      expect(screen.getByTestId('member-sidebar-content')).toBeInTheDocument();
    });

    it('falls back to empty links and presence when those props are omitted', () => {
      render(<MemberSidebar {...defaultProps} links={undefined} onlineMemberIds={undefined} />);

      expect(screen.getByTestId('member-sidebar-content')).toBeInTheDocument();
      // The alice/bob member rows still render off the members prop.
      expect(screen.getByTestId('member-item-m1')).toBeInTheDocument();
    });
  });
});
