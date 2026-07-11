import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import {
  LINK_CREDENTIAL_HEADER,
  resolveCallerMember,
  resolveCallerPublicKey,
  resolveConversationCaller,
} from './caller.js';
import { fakeStores, memberRecord, userRow } from './test-fixtures.js';
import type { Principal } from '../../../lib/context/index.js';
import type { LinkResolutionPort } from '../../identity/index.js';

const CLAIMS = {
  userId: 'u1',
  sessionId: 's1',
  createdAt: 0,
  pending2FA: false,
  pending2FAExpiresAt: 0,
} as const;

const FULL: Principal = { kind: 'full', claims: CLAIMS };
const NONE: Principal = { kind: 'none' };

const CREDENTIAL = 'AQID';

function port(result: { linkId: string; conversationId: string } | null): LinkResolutionPort {
  return { resolveLinkCredential: () => okAsync(result) };
}

describe('LINK_CREDENTIAL_HEADER', () => {
  it('is the shared-link public-key header, matching the media seam', () => {
    expect(LINK_CREDENTIAL_HEADER).toBe('x-link-public-key');
  });
});

describe('resolveConversationCaller', () => {
  it('resolves a full session to a user caller, ignoring any credential', async () => {
    const resolved = await resolveConversationCaller({
      principal: FULL,
      linkCredential: CREDENTIAL,
      linkResolution: port(null),
    });
    expect(resolved._unsafeUnwrap()).toEqual({ kind: 'user', userId: 'u1' });
  });

  it('resolves a live link credential to a link-guest carrying its conversation', async () => {
    const resolved = await resolveConversationCaller({
      principal: NONE,
      linkCredential: CREDENTIAL,
      linkResolution: port({ linkId: 'l1', conversationId: 'c1' }),
    });
    expect(resolved._unsafeUnwrap()).toEqual({
      kind: 'linkGuest',
      linkId: 'l1',
      conversationId: 'c1',
    });
  });

  it('is null when no session and no credential are presented', async () => {
    const resolved = await resolveConversationCaller({
      principal: NONE,
      linkCredential: undefined,
      linkResolution: port(null),
    });
    expect(resolved._unsafeUnwrap()).toBeNull();
  });

  it('is null when the credential resolves to nothing (dead or malformed link)', async () => {
    const resolved = await resolveConversationCaller({
      principal: NONE,
      linkCredential: CREDENTIAL,
      linkResolution: port(null),
    });
    expect(resolved._unsafeUnwrap()).toBeNull();
  });
});

describe('resolveCallerMember', () => {
  it('reads a user caller by userId', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(memberRecord()) } });
    const member = await resolveCallerMember(stores, 'c1', { kind: 'user', userId: 'owner' });
    expect(member._unsafeUnwrap()).not.toBeNull();
  });

  it('reads a link-guest caller by its active member row', async () => {
    const stores = fakeStores({
      members: {
        activeLinkGuest: () =>
          okAsync({
            member: memberRecord({ privilege: 'read' }),
            publicKey: new Uint8Array(32),
            displayName: 'g',
          }),
      },
    });
    const member = await resolveCallerMember(stores, 'c1', {
      kind: 'linkGuest',
      linkId: 'l1',
      conversationId: 'c1',
    });
    expect(member._unsafeUnwrap()?.privilege).toBe('read');
  });

  it('is null for a link guest with no active member row (revoked/left)', async () => {
    const stores = fakeStores({ members: { activeLinkGuest: () => okAsync(null) } });
    const member = await resolveCallerMember(stores, 'c1', {
      kind: 'linkGuest',
      linkId: 'l1',
      conversationId: 'c1',
    });
    expect(member._unsafeUnwrap()).toBeNull();
  });
});

describe('resolveCallerPublicKey', () => {
  it("returns a user member's public key from the users row", async () => {
    const key = new Uint8Array(32).fill(3);
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: (id) => userRow(id, key) },
    });
    const resolved = await resolveCallerPublicKey(stores, 'c1', { kind: 'user', userId: 'owner' });
    expect(resolved._unsafeUnwrap()).toEqual(key);
  });

  it('is null for a non-member user (no active row)', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const resolved = await resolveCallerPublicKey(stores, 'c1', { kind: 'user', userId: 'owner' });
    expect(resolved._unsafeUnwrap()).toBeNull();
  });

  it('throws when an authenticated member has no users row (a defect)', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: () => okAsync(null) },
    });
    await expect(
      resolveCallerPublicKey(stores, 'c1', { kind: 'user', userId: 'owner' })
    ).rejects.toThrow(/no users row/);
  });

  it("returns a link guest's link public key", async () => {
    const key = new Uint8Array(32).fill(9);
    const stores = fakeStores({
      members: {
        activeLinkGuest: () =>
          okAsync({ member: memberRecord(), publicKey: key, displayName: null }),
      },
    });
    const resolved = await resolveCallerPublicKey(stores, 'c1', {
      kind: 'linkGuest',
      linkId: 'l1',
      conversationId: 'c1',
    });
    expect(resolved._unsafeUnwrap()).toEqual(key);
  });

  it('is null for a link guest with no active member row', async () => {
    const stores = fakeStores({ members: { activeLinkGuest: () => okAsync(null) } });
    const resolved = await resolveCallerPublicKey(stores, 'c1', {
      kind: 'linkGuest',
      linkId: 'l1',
      conversationId: 'c1',
    });
    expect(resolved._unsafeUnwrap()).toBeNull();
  });
});
