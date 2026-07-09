import { describe, expect, it } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import {
  createSharedLink,
  createSharedMessage,
  listSharedLinks,
  readPublicShare,
  revokeSharedLink,
} from './shares.js';
import { fakeStores, memberRecord } from './test-fixtures.js';
import type { SharedLinkRecord, SharedMessageRecord } from '../ports/index.js';

const KEY = toBase64(new Uint8Array([7, 7, 7]));
const CONV = 'conv-1';
const LINK = 'link-1';

function linkRecord(overrides: Partial<SharedLinkRecord> = {}): SharedLinkRecord {
  return {
    id: LINK,
    conversationId: CONV,
    displayName: 'a link',
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

function sharedMessage(overrides: Partial<SharedMessageRecord> = {}): SharedMessageRecord {
  return {
    messageId: 'msg-1',
    wrappedContentKey: new Uint8Array([1, 2]),
    createdAt: new Date(0),
    contentItems: [],
    ...overrides,
  };
}

describe('createSharedLink', () => {
  const params = {
    conversationId: CONV,
    callerUserId: 'u1',
    linkPublicKey: KEY,
    displayName: 'a link' as string | null,
    expiresAt: null as string | null,
  };

  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({ members: { lockActiveByUser: () => okAsync(null) } });
    const result = await createSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses forbidden when the caller lacks link-management privilege', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
    });
    const result = await createSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('mints a new link for a privileged member', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { insert: () => okAsync(linkRecord()) },
    });
    const result = await createSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({
      link: {
        id: LINK,
        displayName: 'a link',
        revokedAt: null,
        expiresAt: null,
        createdAt: new Date(0).toISOString(),
      },
      created: true,
    });
  });

  it('converges on the existing link when the public key already exists', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'owner' })) },
      sharedLinks: {
        insert: () => okAsync(null),
        byPublicKey: () => okAsync(linkRecord()),
      },
    });
    const result = await createSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toMatchObject({ created: false, link: { id: LINK } });
  });

  it('refuses conflict when the public key belongs to another conversation', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'owner' })) },
      sharedLinks: {
        insert: () => okAsync(null),
        byPublicKey: () => okAsync(linkRecord({ conversationId: 'other' })),
      },
    });
    const result = await createSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
  });

  it('parses an expiry instant and serializes the stored timestamps', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: {
        insert: () => okAsync(linkRecord({ revokedAt: new Date(5), expiresAt: new Date(10) })),
      },
    });
    const result = await createSharedLink(stores, {
      ...params,
      expiresAt: '2026-07-01T00:00:00.000Z',
    });
    expect(result._unsafeUnwrap()).toEqual({
      link: {
        id: LINK,
        displayName: 'a link',
        revokedAt: new Date(5).toISOString(),
        expiresAt: new Date(10).toISOString(),
        createdAt: new Date(0).toISOString(),
      },
      created: true,
    });
  });

  it('throws a defect when the conflicting key resolves to no row', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'owner' })) },
      sharedLinks: {
        insert: () => okAsync(null),
        byPublicKey: () => okAsync(null),
      },
    });
    await expect(createSharedLink(stores, params)).rejects.toThrow(/link public key/);
  });
});

describe('listSharedLinks', () => {
  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await listSharedLinks(stores, { conversationId: CONV, callerUserId: 'u1' });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('lists the conversation links for an active member', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      sharedLinks: {
        listForConversation: () => okAsync([linkRecord(), linkRecord({ id: 'link-2' })]),
      },
    });
    const result = await listSharedLinks(stores, { conversationId: CONV, callerUserId: 'u1' });
    expect(result._unsafeUnwrap()).toMatchObject({ links: [{ id: LINK }, { id: 'link-2' }] });
  });
});

describe('revokeSharedLink', () => {
  const params = { conversationId: CONV, linkId: LINK, callerUserId: 'u1' };

  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses forbidden when the caller lacks link-management privilege', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('revokes a live link', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { revoke: () => okAsync(linkRecord({ revokedAt: new Date(1) })) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ revoked: true });
  });

  it('revokes an already-expired link as a normal revoke (expiry never gates revoke)', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: {
        revoke: () =>
          okAsync(linkRecord({ expiresAt: new Date(Date.now() - 60_000), revokedAt: new Date() })),
      },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ revoked: true });
  });

  it('is a no-op when the link is already revoked', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: {
        revoke: () => okAsync(null),
        byId: () => okAsync(linkRecord({ revokedAt: new Date(1) })),
      },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ revoked: true });
  });

  it('refuses not-found when the link does not exist', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { revoke: () => okAsync(null), byId: () => okAsync(null) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link belongs to another conversation', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: {
        revoke: () => okAsync(null),
        byId: () => okAsync(linkRecord({ conversationId: 'other', revokedAt: new Date(1) })),
      },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('throws a defect when the missed revoke resolves to a live link', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { revoke: () => okAsync(null), byId: () => okAsync(linkRecord()) },
    });
    await expect(revokeSharedLink(stores, params)).rejects.toThrow(/revoke/);
  });
});

describe('createSharedMessage', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');
  const params = {
    conversationId: CONV,
    callerUserId: 'u1',
    linkId: LINK,
    messageId: 'msg-1',
    wrappedContentKey: toBase64(new Uint8Array([9])),
    now,
  };

  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({ members: { lockActiveByUser: () => okAsync(null) } });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the message is not in the conversation', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      messages: { inConversation: () => okAsync(false) },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link does not exist', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      messages: { inConversation: () => okAsync(true) },
      sharedLinks: { byId: () => okAsync(null) },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link belongs to another conversation', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      messages: { inConversation: () => okAsync(true) },
      sharedLinks: { byId: () => okAsync(linkRecord({ conversationId: 'other' })) },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link is revoked', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      messages: { inConversation: () => okAsync(true) },
      sharedLinks: { byId: () => okAsync(linkRecord({ revokedAt: new Date(1) })) },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link is expired exactly at now (inclusive boundary)', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      messages: { inConversation: () => okAsync(true) },
      sharedLinks: { byId: () => okAsync(linkRecord({ expiresAt: now })) },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('creates a shared message stamped with the creating user', async () => {
    let captured: { createdBy: string } | null = null;
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      messages: { inConversation: () => okAsync(true) },
      sharedLinks: { byId: () => okAsync(linkRecord()) },
      sharedMessages: {
        insert: (p) => {
          captured = { createdBy: p.createdBy };
          return okAsync({ id: 'share-1', createdAt: new Date(0) });
        },
      },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ shareId: 'share-1' });
    expect(captured).toEqual({ createdBy: 'u1' });
  });

  it('stamps the share with its minting link', async () => {
    let captured: { linkId: string } | null = null;
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      messages: { inConversation: () => okAsync(true) },
      sharedLinks: { byId: () => okAsync(linkRecord()) },
      sharedMessages: {
        insert: (p) => {
          captured = { linkId: p.linkId };
          return okAsync({ id: 'share-1', createdAt: new Date(0) });
        },
      },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ shareId: 'share-1' });
    expect(captured).toEqual({ linkId: LINK });
  });

  it('shares into a link expiring just after now', async () => {
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      messages: { inConversation: () => okAsync(true) },
      sharedLinks: { byId: () => okAsync(linkRecord({ expiresAt: new Date(now.getTime() + 1) })) },
      sharedMessages: { insert: () => okAsync({ id: 'share-1', createdAt: new Date(0) }) },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ shareId: 'share-1' });
  });
});

describe('readPublicShare', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  it('refuses not-found when the link does not exist', async () => {
    const stores = fakeStores({ sharedLinks: { byId: () => okAsync(null) } });
    const result = await readPublicShare(stores, { linkId: LINK, now });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found for a revoked link', async () => {
    const stores = fakeStores({
      sharedLinks: { byId: () => okAsync(linkRecord({ revokedAt: new Date(0) })) },
    });
    const result = await readPublicShare(stores, { linkId: LINK, now });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found for a link expired exactly at now (boundary)', async () => {
    const stores = fakeStores({
      sharedLinks: { byId: () => okAsync(linkRecord({ expiresAt: now })) },
    });
    const result = await readPublicShare(stores, { linkId: LINK, now });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('reads a link expiring just after now and returns its shared content', async () => {
    const later = new Date(now.getTime() + 1);
    const stores = fakeStores({
      sharedLinks: { byId: () => okAsync(linkRecord({ expiresAt: later })) },
      sharedMessages: { listForLink: () => okAsync([sharedMessage()]) },
    });
    const result = await readPublicShare(stores, { linkId: LINK, now });
    expect(result._unsafeUnwrap()).toEqual({
      displayName: 'a link',
      sharedMessages: [
        {
          messageId: 'msg-1',
          wrappedContentKey: toBase64(new Uint8Array([1, 2])),
          createdAt: new Date(0).toISOString(),
          contentItems: [],
        },
      ],
    });
  });

  it('reads a link with no expiry', async () => {
    const stores = fakeStores({
      sharedLinks: { byId: () => okAsync(linkRecord({ expiresAt: null })) },
      sharedMessages: { listForLink: () => okAsync([]) },
    });
    const result = await readPublicShare(stores, { linkId: LINK, now });
    expect(result._unsafeUnwrap()).toEqual({ displayName: 'a link', sharedMessages: [] });
  });

  it('lists only the requested link’s shares, never the conversation pool', async () => {
    let requestedLinkId: string | null = null;
    const stores = fakeStores({
      sharedLinks: { byId: () => okAsync(linkRecord()) },
      sharedMessages: {
        listForLink: (linkId) => {
          requestedLinkId = linkId;
          return okAsync([]);
        },
      },
    });
    const result = await readPublicShare(stores, { linkId: LINK, now });
    expect(result._unsafeUnwrap()).toEqual({ displayName: 'a link', sharedMessages: [] });
    expect(requestedLinkId).toBe(LINK);
  });
});
