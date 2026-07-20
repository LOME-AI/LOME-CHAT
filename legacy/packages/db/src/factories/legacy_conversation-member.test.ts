import { describe, it, expect } from 'vitest';

import { conversationMemberFactory } from './legacy_conversation-member';

describe('conversationMemberFactory', () => {
  it('builds a complete conversation member object', () => {
    const member = conversationMemberFactory.build();

    expect(member.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(member.conversationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(member.privilege).toBeTruthy();
    expect(typeof member.visibleFromEpoch).toBe('number');
    expect(member.visibleFromEpoch).toBeGreaterThanOrEqual(1);
    expect(member.joinedAt).toBeInstanceOf(Date);
  });

  it('generates userId by default for user members', () => {
    const member = conversationMemberFactory.build();
    expect(member.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(member.linkId).toBeNull();
  });

  it('generates valid privilege values', () => {
    const validPrivileges = ['read', 'write', 'admin', 'owner'];
    const member = conversationMemberFactory.build();
    expect(validPrivileges).toContain(member.privilege);
  });

  it('generates leftAt as null by default for active members', () => {
    const member = conversationMemberFactory.build();
    expect(member.leftAt).toBeNull();
  });

  it('generates acceptedAt as a Date by default for accepted members', () => {
    const member = conversationMemberFactory.build();
    expect(member.acceptedAt).toBeInstanceOf(Date);
  });

  it('generates invitedByUserId as null by default', () => {
    const member = conversationMemberFactory.build();
    expect(member.invitedByUserId).toBeNull();
  });

  it('allows building unaccepted members via overrides', () => {
    const inviterId = crypto.randomUUID();
    const member = conversationMemberFactory.build({
      acceptedAt: null,
      invitedByUserId: inviterId,
    });
    expect(member.acceptedAt).toBeNull();
    expect(member.invitedByUserId).toBe(inviterId);
  });

  it('allows link-based members via overrides', () => {
    const linkId = crypto.randomUUID();
    const member = conversationMemberFactory.build({ userId: null, linkId });
    expect(member.userId).toBeNull();
    expect(member.linkId).toBe(linkId);
  });

  it('allows field overrides', () => {
    const member = conversationMemberFactory.build({ privilege: 'owner', visibleFromEpoch: 1 });
    expect(member.privilege).toBe('owner');
    expect(member.visibleFromEpoch).toBe(1);
  });

  it('builds a list with unique IDs', () => {
    const memberList = conversationMemberFactory.buildList(3);
    expect(memberList).toHaveLength(3);
    const ids = new Set(memberList.map((m) => m.id));
    expect(ids.size).toBe(3);
  });
});
