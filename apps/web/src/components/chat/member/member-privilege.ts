import { MEMBER_PRIVILEGES } from '@hushbox/shared';

/**
 * Privileges ordered highest→lowest for display grouping and ranking, derived by
 * reversing the canonical low→high `MEMBER_PRIVILEGES`. The shared constant is the
 * single source of the privilege set and its ordering.
 */
export const PRIVILEGE_DISPLAY_ORDER = MEMBER_PRIVILEGES.toReversed();

export const LINK_PRIVILEGE_OPTIONS = ['read', 'write'] as const;

export function groupByPrivilege<T extends { privilege: string }>(items: T[]): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};
  for (const privilege of PRIVILEGE_DISPLAY_ORDER) {
    const matching = items.filter((item) => item.privilege === privilege);
    if (matching.length > 0) {
      grouped[privilege] = matching;
    }
  }
  return grouped;
}
