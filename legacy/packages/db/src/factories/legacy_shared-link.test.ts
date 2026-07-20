import { describe, it, expect } from 'vitest';

import { sharedLinkFactory } from './legacy_shared-link';

describe('sharedLinkFactory', () => {
  it('builds a complete shared link object', () => {
    const link = sharedLinkFactory.build();

    expect(link.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(link.conversationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(link.createdAt).toBeInstanceOf(Date);
  });

  it('generates linkPublicKey as Uint8Array', () => {
    const link = sharedLinkFactory.build();
    expect(link.linkPublicKey).toBeInstanceOf(Uint8Array);
    expect(link.linkPublicKey.length).toBe(32);
  });

  it('generates revokedAt as null by default for active links', () => {
    const link = sharedLinkFactory.build();
    expect(link.revokedAt).toBeNull();
  });

  it('allows revokedAt override for revoked links', () => {
    const revokedDate = new Date();
    const link = sharedLinkFactory.build({ revokedAt: revokedDate });
    expect(link.revokedAt).toBe(revokedDate);
  });

  it('generates displayName as null by default', () => {
    const link = sharedLinkFactory.build();
    expect(link.displayName).toBeNull();
  });

  it('allows displayName override', () => {
    const link = sharedLinkFactory.build({ displayName: 'Dave' });
    expect(link.displayName).toBe('Dave');
  });

  it('builds a list with unique IDs', () => {
    const linkList = sharedLinkFactory.buildList(3);
    expect(linkList).toHaveLength(3);
    const ids = new Set(linkList.map((l) => l.id));
    expect(ids.size).toBe(3);
  });
});
