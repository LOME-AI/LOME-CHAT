import { describe, it, expect } from 'vitest';
import { MEMBER_PRIVILEGES } from '@hushbox/shared';
import {
  PRIVILEGE_DISPLAY_ORDER,
  LINK_PRIVILEGE_OPTIONS,
  groupByPrivilege,
} from '@/components/chat/member/member-privilege';

describe('groupByPrivilege', () => {
  it('groups items into buckets keyed by privilege', () => {
    const items = [
      { id: 'a', privilege: 'owner' },
      { id: 'b', privilege: 'write' },
      { id: 'c', privilege: 'write' },
    ];

    const grouped = groupByPrivilege(items);

    expect(grouped['owner']).toEqual([{ id: 'a', privilege: 'owner' }]);
    expect(grouped['write']).toEqual([
      { id: 'b', privilege: 'write' },
      { id: 'c', privilege: 'write' },
    ]);
  });

  it('omits privilege keys with no matching items', () => {
    const grouped = groupByPrivilege([{ id: 'a', privilege: 'read' }]);

    expect(Object.keys(grouped)).toEqual(['read']);
  });

  it('orders keys following PRIVILEGE_DISPLAY_ORDER', () => {
    const items = [
      { privilege: 'read' },
      { privilege: 'owner' },
      { privilege: 'write' },
      { privilege: 'admin' },
    ];

    expect(Object.keys(groupByPrivilege(items))).toEqual(['owner', 'admin', 'write', 'read']);
  });

  it('returns an empty object for no items', () => {
    expect(groupByPrivilege([])).toEqual({});
  });
});

describe('privilege constants', () => {
  it('orders privileges from highest to lowest', () => {
    expect(PRIVILEGE_DISPLAY_ORDER).toEqual(['owner', 'admin', 'write', 'read']);
  });

  it('derives its order by reversing the canonical shared MEMBER_PRIVILEGES', () => {
    expect(PRIVILEGE_DISPLAY_ORDER).toEqual(MEMBER_PRIVILEGES.toReversed());
  });

  it('limits link privileges to read and write', () => {
    expect(LINK_PRIVILEGE_OPTIONS).toEqual(['read', 'write']);
  });
});
