import * as React from 'react';
import { MoreVertical, LogOut, UserMinus, Shield } from 'lucide-react';
import {
  IconButton,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@hushbox/ui';
import { displayUsername, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { PRIVILEGE_ORDER } from '@/components/chat/member/member-privilege';
import { MemberAvatar } from '@/components/chat/member/member-avatar';

interface MemberRowProps {
  member: {
    id: string;
    // Link-guest members carry null userId/username (see GroupChatProps.members).
    userId: string | null;
    username: string | null;
    privilege: string;
  };
  isCurrentUser: boolean;
  isOnline: boolean;
  isAdmin: boolean;
  onRemoveMember?: ((memberId: string) => void) | undefined;
  onChangePrivilege?: ((memberId: string, newPrivilege: string) => void) | undefined;
  onLeaveClick?: (() => void | Promise<void>) | undefined;
}

export function MemberRow({
  member,
  isCurrentUser,
  isOnline,
  isAdmin,
  onRemoveMember,
  onChangePrivilege,
  onLeaveClick,
}: Readonly<MemberRowProps>): React.JSX.Element {
  const showActions = (isCurrentUser && onLeaveClick !== undefined) || (isAdmin && !isCurrentUser);

  return (
    <div
      data-testid={TEST_ID_BUILDERS.memberItem(member.id)}
      className="flex items-center justify-between py-2"
    >
      <div className="flex items-center gap-2">
        <MemberAvatar
          initial={member.username === null ? '?' : displayUsername(member.username).charAt(0)}
          isOnline={isOnline}
          size="md"
          testIdPrefix="member"
          entityId={member.id}
        />
        <span className="text-sm">
          {member.username === null ? 'Guest' : displayUsername(member.username)}
          {isCurrentUser && (
            <span data-testid={TEST_IDS.memberYouBadge} className="text-muted-foreground ml-1">
              (you)
            </span>
          )}
        </span>
      </div>
      {showActions && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              aria-label="More options"
              data-testid={TEST_ID_BUILDERS.memberActions(member.id)}
            >
              <MoreVertical className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isCurrentUser ? (
              <DropdownMenuItem
                data-testid={TEST_IDS.memberLeaveAction}
                className="text-destructive"
                onSelect={() => {
                  void onLeaveClick?.();
                }}
              >
                <LogOut className="mr-2 h-4 w-4" />
                Leave
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuLabel
                  data-testid={TEST_ID_BUILDERS.memberChangePrivilege(member.id)}
                  className="flex items-center gap-2 text-xs font-normal"
                >
                  <Shield className="h-4 w-4" />
                  Change privilege
                </DropdownMenuLabel>
                {/*
                  Flattened radio group instead of a DropdownMenuSub. The Sub
                  flow loses pointer events on Firefox (and on touch devices)
                  because the SubContent's DismissableLayer can intercept the
                  pointerdown and unmount the SubContent before the click
                  reaches the inner item. RadioGroup inside the same content
                  has no portal-within-portal, so the click path is reliable
                  cross-browser. Each radio's value is the literal privilege
                  string; the onValueChange handler invokes the same callback
                  as the previous DropdownMenuItem.onSelect did.
                */}
                <DropdownMenuRadioGroup
                  value={member.privilege}
                  onValueChange={(next) => onChangePrivilege?.(member.id, next)}
                >
                  {PRIVILEGE_ORDER.filter((p) => p !== 'owner').map((priv) => (
                    <DropdownMenuRadioItem
                      key={priv}
                      value={priv}
                      data-testid={TEST_ID_BUILDERS.privilegeOption(member.id, priv)}
                    >
                      {priv}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid={TEST_ID_BUILDERS.memberRemoveAction(member.id)}
                  className="text-destructive"
                  onSelect={() => onRemoveMember?.(member.id)}
                >
                  <UserMinus className="mr-2 h-4 w-4" />
                  Remove Member
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
