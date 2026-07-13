import * as React from 'react';
import { cn } from '@hushbox/ui';
import { displayUsername, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';

const MAX_VISIBLE_AVATARS = 3;

interface MemberFacepileProps {
  // A link-guest member has no user account: both `userId` and `username` are
  // null (backend `members.ts` types `username` nullable, and the users
  // left-join yields null for a guest with no userId).
  members: { id: string; userId: string | null; username: string | null }[];
  onlineMemberIds: Set<string>;
  onFacepileClick: () => void;
}

export function MemberFacepile({
  members,
  onlineMemberIds,
  onFacepileClick,
}: Readonly<MemberFacepileProps>): React.JSX.Element | null {
  if (members.length === 0) {
    return null;
  }

  const visibleMembers = members.slice(0, MAX_VISIBLE_AVATARS);
  const overflowCount = members.length - MAX_VISIBLE_AVATARS;

  return (
    <button
      type="button"
      data-testid={TEST_IDS.memberFacepile}
      className="flex cursor-pointer items-center"
      onClick={onFacepileClick}
    >
      {visibleMembers.map((member, index) => (
        <div
          key={member.id}
          data-testid={TEST_ID_BUILDERS.memberAvatar(member.id)}
          className={cn(
            'border-background bg-muted text-muted-foreground relative flex h-6 w-6 items-center justify-center rounded-full border text-xs font-medium',
            index > 0 && '-ml-2'
          )}
        >
          {member.username === null ? '?' : displayUsername(member.username).charAt(0)}
          {member.userId !== null && onlineMemberIds.has(member.userId) && (
            <span
              data-testid={TEST_ID_BUILDERS.onlineIndicator(member.id)}
              className="absolute right-0 bottom-0 h-2 w-2 rounded-full border border-white bg-green-500"
            />
          )}
        </div>
      ))}
      {overflowCount > 0 && (
        <span
          data-testid={TEST_IDS.memberCountBadge}
          className="bg-muted text-muted-foreground -ml-2 flex h-6 items-center justify-center rounded-full px-1.5 text-xs font-medium"
        >
          +{overflowCount}
        </span>
      )}
    </button>
  );
}
