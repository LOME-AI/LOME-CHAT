import type { MemberPrivilege } from '../member-privilege.js';

/** Numeric ordering: read=0, write=1, admin=2, owner=3 */
const PRIVILEGE_LEVEL: Record<MemberPrivilege, number> = {
  read: 0,
  write: 1,
  admin: 2,
  owner: 3,
};

/** Returns the numeric level for a privilege string */
export function getPrivilegeLevel(privilege: string): number {
  if (privilege in PRIVILEGE_LEVEL) {
    return PRIVILEGE_LEVEL[privilege as MemberPrivilege];
  }
  return -1;
}

/** Whether the actor can remove the target. Actor must be strictly higher than target. */
export function canRemoveMember(actorPrivilege: string, targetPrivilege: string): boolean {
  const actorLevel = getPrivilegeLevel(actorPrivilege);
  const targetLevel = getPrivilegeLevel(targetPrivilege);
  // Must be strictly higher and at least admin
  return actorLevel >= PRIVILEGE_LEVEL.admin && actorLevel > targetLevel;
}

/** Whether the actor can add members to a conversation */
export function canAddMembers(privilege: string): boolean {
  return getPrivilegeLevel(privilege) >= PRIVILEGE_LEVEL.admin;
}

/** Whether the actor can manage shared links */
export function canManageLinks(privilege: string): boolean {
  return getPrivilegeLevel(privilege) >= PRIVILEGE_LEVEL.admin;
}

/** Whether the actor can send messages */
export function canSendMessages(privilege: string): boolean {
  return getPrivilegeLevel(privilege) >= PRIVILEGE_LEVEL.write;
}

/**
 * Whether the actor can change another member's privilege.
 * Must be admin+ and the target's current privilege must be strictly lower than actor's.
 * The new privilege must also be strictly lower than the actor's.
 */
export function canChangePrivilege(
  actorPrivilege: string,
  targetCurrentPrivilege: string,
  newPrivilege: string
): boolean {
  const actorLevel = getPrivilegeLevel(actorPrivilege);
  const targetLevel = getPrivilegeLevel(targetCurrentPrivilege);
  const newLevel = getPrivilegeLevel(newPrivilege);
  // Must be at least admin, target must be below actor, new privilege must be below actor
  return actorLevel >= PRIVILEGE_LEVEL.admin && actorLevel > targetLevel && actorLevel > newLevel;
}

/** Whether the privilege level is the owner */
export function isOwner(privilege: string): boolean {
  return privilege === 'owner';
}
