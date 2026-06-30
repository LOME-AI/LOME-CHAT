import { describe, it, expect } from 'vitest';

import { epochMemberFactory } from './legacy_epoch-member';

describe('epochMemberFactory', () => {
  it('builds a complete epoch member object', () => {
    const member = epochMemberFactory.build();

    expect(member.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(member.epochId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(typeof member.visibleFromEpoch).toBe('number');
    expect(member.visibleFromEpoch).toBeGreaterThanOrEqual(1);
    expect(member.createdAt).toBeInstanceOf(Date);
  });

  it('generates bytea fields as Uint8Array', () => {
    const member = epochMemberFactory.build();

    expect(member.memberPublicKey).toBeInstanceOf(Uint8Array);
    expect(member.memberPublicKey.length).toBe(32);
    expect(member.wrap).toBeInstanceOf(Uint8Array);
    expect(member.wrap.length).toBeGreaterThan(0);
  });

  it('allows field overrides', () => {
    const member = epochMemberFactory.build({ visibleFromEpoch: 5 });
    expect(member.visibleFromEpoch).toBe(5);
  });

  it('builds a list with unique IDs', () => {
    const memberList = epochMemberFactory.buildList(3);
    expect(memberList).toHaveLength(3);
    const ids = new Set(memberList.map((m) => m.id));
    expect(ids.size).toBe(3);
  });
});
