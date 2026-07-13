import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { MemberFacepile } from '@/components/chat/member/member-facepile';

describe('MemberFacepile', () => {
  const defaultMembers = [
    { id: 'member-1', userId: 'user-1', username: 'alice' },
    { id: 'member-2', userId: 'user-2', username: 'bob' },
    { id: 'member-3', userId: 'user-3', username: 'charlie' },
  ];

  describe('rendering', () => {
    it('shows nothing when member count is 0', () => {
      const { container } = render(
        <MemberFacepile members={[]} onlineMemberIds={new Set()} onFacepileClick={vi.fn()} />
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders the facepile container', () => {
      render(
        <MemberFacepile
          members={defaultMembers}
          onlineMemberIds={new Set()}
          onFacepileClick={vi.fn()}
        />
      );
      expect(screen.getByTestId('member-facepile')).toBeInTheDocument();
    });

    it('renders an avatar for each member up to 3', () => {
      render(
        <MemberFacepile
          members={defaultMembers}
          onlineMemberIds={new Set()}
          onFacepileClick={vi.fn()}
        />
      );
      expect(screen.getByTestId('member-avatar-member-1')).toBeInTheDocument();
      expect(screen.getByTestId('member-avatar-member-2')).toBeInTheDocument();
      expect(screen.getByTestId('member-avatar-member-3')).toBeInTheDocument();
    });

    it('displays first letter of username uppercased', () => {
      render(
        <MemberFacepile
          members={[{ id: 'member-1', userId: 'user-1', username: 'alice' }]}
          onlineMemberIds={new Set()}
          onFacepileClick={vi.fn()}
        />
      );
      expect(screen.getByTestId('member-avatar-member-1')).toHaveTextContent('A');
    });

    it('renders a fallback initial for a link-guest member (null username/userId) without throwing', () => {
      const members = [
        { id: 'member-1', userId: 'user-1', username: 'alice' },
        { id: 'member-2', userId: null, username: null },
      ];
      expect(() =>
        render(
          <MemberFacepile members={members} onlineMemberIds={new Set()} onFacepileClick={vi.fn()} />
        )
      ).not.toThrow();
      // Real member keeps their normal initial.
      expect(screen.getByTestId('member-avatar-member-1')).toHaveTextContent('A');
      // Link guest shows the fallback initial, not a crash.
      expect(screen.getByTestId('member-avatar-member-2')).toHaveTextContent('?');
    });

    it('treats a link-guest member (null userId) as offline even if presence set is non-empty', () => {
      render(
        <MemberFacepile
          members={[{ id: 'member-2', userId: null, username: null }]}
          onlineMemberIds={new Set(['user-1'])}
          onFacepileClick={vi.fn()}
        />
      );
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.onlineIndicator('member-2'))
      ).not.toBeInTheDocument();
    });

    it('displays first letter of multi-word display name via displayUsername', () => {
      render(
        <MemberFacepile
          members={[{ id: 'member-1', userId: 'user-1', username: 'alice_smith' }]}
          onlineMemberIds={new Set()}
          onFacepileClick={vi.fn()}
        />
      );
      expect(screen.getByTestId('member-avatar-member-1')).toHaveTextContent('A');
    });

    it('renders avatars as 24px circles', () => {
      render(
        <MemberFacepile
          members={[{ id: 'member-1', userId: 'user-1', username: 'alice' }]}
          onlineMemberIds={new Set()}
          onFacepileClick={vi.fn()}
        />
      );
      const avatar = screen.getByTestId('member-avatar-member-1');
      expect(avatar).toHaveClass('rounded-full');
      expect(avatar).toHaveClass('h-6');
      expect(avatar).toHaveClass('w-6');
    });

    it('applies negative margin-left overlap on non-first avatars', () => {
      render(
        <MemberFacepile
          members={defaultMembers}
          onlineMemberIds={new Set()}
          onFacepileClick={vi.fn()}
        />
      );
      const first = screen.getByTestId('member-avatar-member-1');
      const second = screen.getByTestId('member-avatar-member-2');
      expect(first).not.toHaveClass('-ml-2');
      expect(second).toHaveClass('-ml-2');
    });

    it('uses theme-consistent background and text colors', () => {
      render(
        <MemberFacepile
          members={[{ id: 'member-1', userId: 'user-1', username: 'alice' }]}
          onlineMemberIds={new Set()}
          onFacepileClick={vi.fn()}
        />
      );
      const avatar = screen.getByTestId('member-avatar-member-1');
      expect(avatar).toHaveClass('bg-muted');
      expect(avatar).toHaveClass('text-muted-foreground');
    });
  });

  describe('overflow badge', () => {
    it('does not show count badge when 3 or fewer members', () => {
      render(
        <MemberFacepile
          members={defaultMembers}
          onlineMemberIds={new Set()}
          onFacepileClick={vi.fn()}
        />
      );
      expect(screen.queryByTestId('member-count-badge')).not.toBeInTheDocument();
    });

    it('shows +N count badge when more than 3 members', () => {
      const members = [
        ...defaultMembers,
        { id: 'member-4', userId: 'user-4', username: 'david' },
        { id: 'member-5', userId: 'user-5', username: 'eve' },
      ];
      render(
        <MemberFacepile members={members} onlineMemberIds={new Set()} onFacepileClick={vi.fn()} />
      );
      const badge = screen.getByTestId('member-count-badge');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent('+2');
    });

    it('only renders first 3 avatars when more than 3 members', () => {
      const members = [...defaultMembers, { id: 'member-4', userId: 'user-4', username: 'david' }];
      render(
        <MemberFacepile members={members} onlineMemberIds={new Set()} onFacepileClick={vi.fn()} />
      );
      expect(screen.getByTestId('member-avatar-member-1')).toBeInTheDocument();
      expect(screen.getByTestId('member-avatar-member-2')).toBeInTheDocument();
      expect(screen.getByTestId('member-avatar-member-3')).toBeInTheDocument();
      expect(screen.queryByTestId('member-avatar-member-4')).not.toBeInTheDocument();
    });
  });

  describe('online indicator', () => {
    it('shows green dot for online members matched by userId', () => {
      render(
        <MemberFacepile
          members={defaultMembers}
          onlineMemberIds={new Set(['user-1'])}
          onFacepileClick={vi.fn()}
        />
      );
      expect(screen.getByTestId(TEST_ID_BUILDERS.onlineIndicator('member-1'))).toBeInTheDocument();
    });

    it('does not show green dot for offline members', () => {
      render(
        <MemberFacepile
          members={defaultMembers}
          onlineMemberIds={new Set(['user-1'])}
          onFacepileClick={vi.fn()}
        />
      );
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.onlineIndicator('member-2'))
      ).not.toBeInTheDocument();
    });

    it('online dot has green background and white border', () => {
      render(
        <MemberFacepile
          members={defaultMembers}
          onlineMemberIds={new Set(['user-1'])}
          onFacepileClick={vi.fn()}
        />
      );
      const dot = screen.getByTestId(TEST_ID_BUILDERS.onlineIndicator('member-1'));
      expect(dot).toHaveClass('bg-green-500');
      expect(dot).toHaveClass('border-white');
    });

    it('online dot is positioned bottom-right', () => {
      render(
        <MemberFacepile
          members={defaultMembers}
          onlineMemberIds={new Set(['user-1'])}
          onFacepileClick={vi.fn()}
        />
      );
      const dot = screen.getByTestId(TEST_ID_BUILDERS.onlineIndicator('member-1'));
      expect(dot).toHaveClass('absolute');
      expect(dot).toHaveClass('bottom-0');
      expect(dot).toHaveClass('right-0');
    });
  });

  describe('click interaction', () => {
    it('calls onFacepileClick when facepile is clicked', async () => {
      const user = userEvent.setup();
      const onClick = vi.fn();
      render(
        <MemberFacepile
          members={defaultMembers}
          onlineMemberIds={new Set()}
          onFacepileClick={onClick}
        />
      );
      await user.click(screen.getByTestId('member-facepile'));
      expect(onClick).toHaveBeenCalledOnce();
    });

    it('has pointer cursor on the facepile', () => {
      render(
        <MemberFacepile
          members={defaultMembers}
          onlineMemberIds={new Set()}
          onFacepileClick={vi.fn()}
        />
      );
      expect(screen.getByTestId('member-facepile')).toHaveClass('cursor-pointer');
    });
  });
});
