import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';
import {
  MemberSidebarBody,
  type MemberSidebarBodyProps,
} from '@/components/chat/member/member-sidebar-body';

function makeMembers(): MemberSidebarBodyProps['members'] {
  return [
    { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
    { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
    { id: 'guest1', userId: null, username: null, privilege: 'read' },
  ];
}

function makeLinks(): MemberSidebarBodyProps['links'] {
  return [
    {
      id: 'link1',
      displayName: 'Reading link',
      privilege: 'read',
      createdAt: '2026-02-01T00:00:00Z',
    },
  ];
}

function baseProps(overrides: Partial<MemberSidebarBodyProps> = {}): MemberSidebarBodyProps {
  return {
    members: makeMembers(),
    links: makeLinks(),
    onlineMemberIds: new Set(['u1']),
    currentUserId: 'u1',
    currentUserLinkId: null,
    currentUserPrivilege: 'owner',
    conversationId: 'conv-1',
    collapsed: false,
    ...overrides,
  };
}

describe('MemberSidebarBody', () => {
  it('confirms member removal, invoking onRemoveMember once', async () => {
    const user = userEvent.setup();
    const onRemoveMember = vi.fn();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRemoveMember })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('m2')));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_ID_BUILDERS.memberRemoveAction('m2'))).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberRemoveAction('m2')));
    await user.click(await screen.findByTestId('remove-member-confirm'));

    expect(onRemoveMember).toHaveBeenCalledWith('m2');
  });

  it('closes the remove modal on cancel without calling onRemoveMember', async () => {
    const user = userEvent.setup();
    const onRemoveMember = vi.fn();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRemoveMember })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('m2')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.memberRemoveAction('m2')));
    await user.click(await screen.findByTestId('remove-member-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('remove-member-modal')).not.toBeInTheDocument();
    });
    expect(onRemoveMember).not.toHaveBeenCalled();
  });

  it('confirms removal safely when no onRemoveMember handler is wired', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRemoveMember: undefined })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('m2')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.memberRemoveAction('m2')));
    await user.click(await screen.findByTestId('remove-member-confirm'));

    await waitFor(() => {
      expect(screen.queryByTestId('remove-member-modal')).not.toBeInTheDocument();
    });
  });

  it('labels a guest member as "this member" in the remove dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRemoveMember: vi.fn() })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('guest1')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.memberRemoveAction('guest1')));

    expect(await screen.findByTestId('remove-member-title')).toHaveTextContent(
      'Remove this member?'
    );
  });

  it('awaits an async privilege change', async () => {
    const user = userEvent.setup();
    const onChangePrivilege = vi.fn(() => Promise.resolve());
    renderWithProviders(<MemberSidebarBody {...baseProps({ onChangePrivilege })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('m2')));
    fireEvent.click(await screen.findByTestId(TEST_ID_BUILDERS.privilegeOption('m2', 'read')));

    await waitFor(() => {
      expect(onChangePrivilege).toHaveBeenCalledWith('m2', 'read');
    });
  });

  it('confirms link revocation and calls onRevokeLinkClick', async () => {
    const user = userEvent.setup();
    const onRevokeLinkClick = vi.fn();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRevokeLinkClick })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkActions('link1')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.linkRevokeAction('link1')));
    await user.click(await screen.findByTestId('revoke-link-confirm'));

    expect(onRevokeLinkClick).toHaveBeenCalledWith('link1');
  });

  it('confirms link revocation safely when no onRevokeLinkClick handler is wired', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRevokeLinkClick: undefined })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkActions('link1')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.linkRevokeAction('link1')));
    await user.click(await screen.findByTestId('revoke-link-confirm'));

    await waitFor(() => {
      expect(screen.queryByTestId('revoke-link-modal')).not.toBeInTheDocument();
    });
  });

  it('awaits an async link privilege change', async () => {
    const user = userEvent.setup();
    const onChangeLinkPrivilege = vi.fn(() => Promise.resolve());
    renderWithProviders(<MemberSidebarBody {...baseProps({ onChangeLinkPrivilege })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkActions('link1')));
    fireEvent.click(
      await screen.findByTestId(TEST_ID_BUILDERS.linkPrivilegeOption('link1', 'write'))
    );

    await waitFor(() => {
      expect(onChangeLinkPrivilege).toHaveBeenCalledWith('link1', 'write');
    });
  });

  it('awaits an async link name save', async () => {
    const user = userEvent.setup();
    const onSaveLinkName = vi.fn(() => Promise.resolve());
    renderWithProviders(<MemberSidebarBody {...baseProps({ onSaveLinkName })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkActions('link1')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.linkChangeName('link1')));

    const input = await screen.findByTestId(TEST_ID_BUILDERS.linkNameInput('link1'));
    await user.clear(input);
    await user.type(input, 'Renamed{Enter}');

    await waitFor(() => {
      expect(onSaveLinkName).toHaveBeenCalledWith('link1', 'Renamed');
    });
  });

  it('filters members by the search query', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemberSidebarBody {...baseProps()} />);

    await user.type(screen.getByTestId(TEST_IDS.memberSearchInput), 'bob');

    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('renders a compact avatar column with an overflow count when collapsed', () => {
    const manyMembers = Array.from({ length: 10 }, (_v, index) => ({
      id: `m${String(index)}`,
      userId: `u${String(index)}`,
      username: `user${String(index)}`,
      privilege: 'read',
    }));
    manyMembers.push({
      id: 'g',
      userId: null as unknown as string,
      username: null as unknown as string,
      privilege: 'read',
    });

    renderWithProviders(
      <MemberSidebarBody {...baseProps({ members: manyMembers, collapsed: true })} />
    );

    expect(screen.getByTestId(TEST_IDS.memberOverflowCount)).toHaveTextContent('+3');
  });
});
