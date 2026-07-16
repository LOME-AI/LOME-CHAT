import * as React from 'react';
import { Search } from 'lucide-react';
import { Input, Separator, useAsyncAction } from '@hushbox/ui';
import {
  canManageLinks,
  normalizeUsername,
  displayUsername,
  TEST_IDS,
  TEST_ID_BUILDERS,
} from '@hushbox/shared';
import { ConfirmationModal } from '@/components/shared/confirmation-modal';
import { LeaveConfirmationModal } from '@/components/chat/member/leave-confirmation-modal';
import { PRIVILEGE_ORDER, groupByPrivilege } from '@/components/chat/member/member-privilege';
import { AdminActionButtons } from '@/components/chat/member/admin-action-buttons';
import { MemberAvatar } from '@/components/chat/member/member-avatar';
import { MemberRow } from '@/components/chat/member/member-row';
import { LinkRow } from '@/components/chat/member/link-row';

export interface MemberEntry {
  id: string;
  // Link-guest members carry null userId/username (see GroupChatProps.members).
  userId: string | null;
  username: string | null;
  privilege: string;
}

export interface LinkEntry {
  id: string;
  displayName: string | null;
  privilege: string;
  createdAt: string;
}

export interface MemberSidebarCallbacks {
  onRemoveMember?: ((memberId: string) => void | Promise<void>) | undefined;
  onChangePrivilege?:
    | ((memberId: string, newPrivilege: string) => void | Promise<void>)
    | undefined;
  onRevokeLinkClick?: ((linkId: string) => void | Promise<void>) | undefined;
  onSaveLinkName?: ((linkId: string, newName: string) => void | Promise<void>) | undefined;
  onChangeLinkPrivilege?:
    | ((linkId: string, newPrivilege: string) => void | Promise<void>)
    | undefined;
  onBudgetSettingsClick?: (() => void) | undefined;
  onLeaveClick?: (() => void | Promise<void>) | undefined;
  onAddMember?: (() => void) | undefined;
  onInviteLink?: (() => void) | undefined;
}

export interface MemberSidebarBodyProps extends MemberSidebarCallbacks {
  members: MemberEntry[];
  links: LinkEntry[];
  onlineMemberIds: Set<string>;
  currentUserId: string;
  currentUserLinkId: string | null;
  currentUserPrivilege: string;
  conversationId: string;
  collapsed: boolean;
}

export function MemberSidebarBody({
  members,
  links,
  onlineMemberIds,
  currentUserId,
  currentUserLinkId,
  currentUserPrivilege,
  onRemoveMember,
  onChangePrivilege,
  onRevokeLinkClick,
  onSaveLinkName,
  onChangeLinkPrivilege,
  onAddMember,
  onInviteLink,
  onLeaveClick,
  collapsed,
  conversationId,
}: Readonly<MemberSidebarBodyProps>): React.JSX.Element {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [leaveModalOpen, setLeaveModalOpen] = React.useState(false);
  const [removeMemberTarget, setRemoveMemberTarget] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const [revokeLinkTarget, setRevokeLinkTarget] = React.useState<{
    id: string;
    name: string;
  } | null>(null);
  const isAdmin = canManageLinks(currentUserPrivilege);

  // Reset transient UI state when switching conversations. Replaces the
  // parent's `key={conversationId}` remount, which (along with the
  // MessageList remount) was the source of the welcome → conversation flash.
  const previousConversationIdRef = React.useRef<string>(conversationId);
  React.useEffect(() => {
    if (previousConversationIdRef.current === conversationId) return;
    previousConversationIdRef.current = conversationId;
    setSearchQuery('');
    setLeaveModalOpen(false);
    setRemoveMemberTarget(null);
    setRevokeLinkTarget(null);
  }, [conversationId]);

  // Inline-control mutations (privilege select-on-change, name inline-edit,
  // link-privilege select-on-change) have no modal to attach an error to.
  // Wrap each in useAsyncAction with fallback='toast' so failures still
  // surface visibly instead of being silently swallowed by the void caller.
  const changePrivilegeAction = useAsyncAction({ fallback: 'toast' });
  const saveLinkNameAction = useAsyncAction({ fallback: 'toast' });
  const changeLinkPrivilegeAction = useAsyncAction({ fallback: 'toast' });

  const handleChangePrivilege = React.useCallback(
    (memberId: string, newPrivilege: string): void => {
      void changePrivilegeAction.run(async () => {
        const maybe = onChangePrivilege?.(memberId, newPrivilege);
        if (maybe instanceof Promise) await maybe;
      });
    },
    [onChangePrivilege, changePrivilegeAction]
  );

  const handleSaveLinkName = React.useCallback(
    (linkId: string, newName: string): void => {
      void saveLinkNameAction.run(async () => {
        const maybe = onSaveLinkName?.(linkId, newName);
        if (maybe instanceof Promise) await maybe;
      });
    },
    [onSaveLinkName, saveLinkNameAction]
  );

  const handleChangeLinkPrivilege = React.useCallback(
    (linkId: string, newPrivilege: string): void => {
      void changeLinkPrivilegeAction.run(async () => {
        const maybe = onChangeLinkPrivilege?.(linkId, newPrivilege);
        if (maybe instanceof Promise) await maybe;
      });
    },
    [onChangeLinkPrivilege, changeLinkPrivilegeAction]
  );

  const filteredMembers = React.useMemo(() => {
    if (searchQuery.trim() === '') return members;
    const normalizedQuery = normalizeUsername(searchQuery);
    return members.filter((m) => (m.username ?? '').includes(normalizedQuery));
  }, [members, searchQuery]);

  const membersByPrivilege = React.useMemo(
    () => groupByPrivilege(filteredMembers),
    [filteredMembers]
  );

  const filteredLinks = React.useMemo(() => {
    if (searchQuery.trim() === '') return links;
    const query = searchQuery.toLowerCase();
    return links.filter((l) => (l.displayName ?? '').toLowerCase().includes(query));
  }, [links, searchQuery]);

  const linksByPrivilege = React.useMemo(() => groupByPrivilege(filteredLinks), [filteredLinks]);

  const handleRequestRemove = React.useCallback(
    (memberId: string): void => {
      const member = members.find((m) => m.id === memberId);
      setRemoveMemberTarget({
        id: memberId,
        name: member?.username ? displayUsername(member.username) : 'this member',
      });
    },
    [members]
  );

  const handleRequestRevoke = React.useCallback((linkId: string, displayName: string): void => {
    setRevokeLinkTarget({ id: linkId, name: displayName });
  }, []);

  if (collapsed) {
    return (
      <div
        data-testid={TEST_IDS.memberSidebarContent}
        className="scrollbar-hide flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto"
      >
        {isAdmin && (
          <AdminActionButtons collapsed onAddMember={onAddMember} onInviteLink={onInviteLink} />
        )}
        <Separator className="bg-sidebar-border w-full" />
        {members.slice(0, 8).map((member) => (
          <div key={member.id} data-testid={TEST_ID_BUILDERS.memberAvatar(member.id)}>
            <MemberAvatar
              initial={member.username === null ? '?' : displayUsername(member.username).charAt(0)}
              isOnline={member.userId !== null && onlineMemberIds.has(member.userId)}
              size="sm"
              testIdPrefix="member-avatar"
              entityId={member.id}
            />
          </div>
        ))}
        {members.length > 8 && (
          <span
            data-testid={TEST_IDS.memberOverflowCount}
            className="text-muted-foreground text-xs"
          >
            +{members.length - 8}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid={TEST_IDS.memberSidebarContent}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {isAdmin && (
        <div className="mb-3 flex flex-col gap-2">
          <AdminActionButtons
            collapsed={false}
            onAddMember={onAddMember}
            onInviteLink={onInviteLink}
          />
        </div>
      )}

      <div className="mb-3">
        <Input
          icon={<Search className="h-4 w-4" />}
          data-testid={TEST_IDS.memberSearchInput}
          label="Search members"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
          }}
        />
      </div>

      <Separator className="bg-sidebar-border mb-3" />

      <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto">
        {PRIVILEGE_ORDER.map((privilege) => {
          const memberGroup = membersByPrivilege[privilege];
          const linkGroup = linksByPrivilege[privilege];
          if (!memberGroup && !linkGroup) return null;

          return (
            <div
              key={privilege}
              data-testid={TEST_ID_BUILDERS.memberSection(privilege)}
              className="mb-4"
            >
              <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
                {privilege}
              </h3>
              {memberGroup?.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  isCurrentUser={member.userId === currentUserId}
                  isOnline={member.userId !== null && onlineMemberIds.has(member.userId)}
                  isAdmin={isAdmin}
                  onRemoveMember={handleRequestRemove}
                  onChangePrivilege={
                    onChangePrivilege === undefined ? undefined : handleChangePrivilege
                  }
                  onLeaveClick={
                    onLeaveClick === undefined
                      ? undefined
                      : () => {
                          setLeaveModalOpen(true);
                        }
                  }
                />
              ))}
              {linkGroup?.map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  index={links.indexOf(link)}
                  isCurrentLink={currentUserLinkId !== null && link.id === currentUserLinkId}
                  isAdmin={isAdmin}
                  onChangeLinkPrivilege={
                    onChangeLinkPrivilege === undefined ? undefined : handleChangeLinkPrivilege
                  }
                  onSaveLinkName={onSaveLinkName === undefined ? undefined : handleSaveLinkName}
                  onRequestRevoke={handleRequestRevoke}
                />
              ))}
            </div>
          );
        })}
      </div>

      <LeaveConfirmationModal
        open={leaveModalOpen}
        onOpenChange={setLeaveModalOpen}
        isOwner={currentUserPrivilege === 'owner'}
        onConfirm={async () => {
          // Propagate the Promise so LeaveConfirmationModal's ActionModal
          // can hold the inline-error region open on failure (instead of
          // closing optimistically and losing the rotation result).
          await onLeaveClick?.();
        }}
      />
      <ConfirmationModal
        open={removeMemberTarget !== null}
        onOpenChange={(open) => {
          /* v8 ignore next -- a controlled ConfirmationModal only ever emits onOpenChange(false); the open===true branch is unreachable */
          if (!open) setRemoveMemberTarget(null);
        }}
        title={`Remove ${removeMemberTarget?.name ?? ''}?`}
        warning="This member will lose access to the conversation."
        confirmLabel="Remove"
        onConfirm={async () => {
          // Awaiting onRemoveMember surfaces its Promise to ConfirmationModal's
          // ActionModal. On success, both the explicit setState below and the
          // modal's own onOpenChange close the overlay; on failure, the throw
          // skips setState and the modal stays open with the inline error.
          /* v8 ignore next -- onConfirm only fires while the modal is open, which requires removeMemberTarget to be non-null */
          if (removeMemberTarget) await onRemoveMember?.(removeMemberTarget.id);
          setRemoveMemberTarget(null);
        }}
        ariaLabel="Remove Member"
        testIdPrefix="remove-member"
      />
      <ConfirmationModal
        open={revokeLinkTarget !== null}
        onOpenChange={(open) => {
          /* v8 ignore next -- a controlled ConfirmationModal only ever emits onOpenChange(false); the open===true branch is unreachable */
          if (!open) setRevokeLinkTarget(null);
        }}
        title={`Revoke ${revokeLinkTarget?.name ?? ''}?`}
        warning="Anyone with this link will lose access to the conversation."
        confirmLabel="Revoke"
        onConfirm={async () => {
          /* v8 ignore next -- onConfirm only fires while the modal is open, which requires revokeLinkTarget to be non-null */
          if (revokeLinkTarget) await onRevokeLinkClick?.(revokeLinkTarget.id);
          setRevokeLinkTarget(null);
        }}
        ariaLabel="Revoke Link"
        testIdPrefix="revoke-link"
      />
    </div>
  );
}
