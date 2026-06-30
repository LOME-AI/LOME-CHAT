import { describe, expect, it } from 'vitest';
import { MEMBER_PRIVILEGES, MemberPrivilege } from './member-privilege.js';

describe('MEMBER_PRIVILEGES', () => {
  it('contains exactly the four closed privileges in order', () => {
    expect(MEMBER_PRIVILEGES).toEqual(['read', 'write', 'admin', 'owner']);
  });
});

describe('MemberPrivilege', () => {
  it('parses every member of the closed set', () => {
    for (const privilege of MEMBER_PRIVILEGES) {
      expect(MemberPrivilege.safeParse(privilege).success).toBe(true);
    }
  });

  it('rejects an unknown string', () => {
    expect(MemberPrivilege.safeParse('moderator').success).toBe(false);
  });

  it('is closed at the type level', () => {
    // @ts-expect-error -- 'moderator' is not a member of the closed MemberPrivilege union
    const invalid: MemberPrivilege = 'moderator';
    expect(MEMBER_PRIVILEGES).not.toContain(invalid);
  });
});
