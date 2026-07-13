import { describe, expect, it } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import {
  changeLinkName,
  changeLinkPrivilege,
  createSharedLink,
  createSharedMessage,
  listSharedLinks,
  readSharedMessage,
  revokeSharedLink,
} from './shares.js';
import { conversationRecord, fakeStores, memberRecord } from './test-fixtures.js';
import type { RotationBody } from './schemas.js';
import type { MemberKeyRecord, SharedLinkRecord, SharedMessageRecord } from '../ports/index.js';

const KEY = toBase64(new Uint8Array([7, 7, 7]));
const OWNER_KEY = new Uint8Array([1, 1, 1]);
const LINK_KEY = new Uint8Array([7, 7, 7]);
const B64 = toBase64(new Uint8Array([2, 2, 2]));
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
    id: 'shared-msg-1',
    messageId: 'msg-1',
    wrappedContentKey: new Uint8Array([1, 2]),
    createdAt: new Date(0),
    contentItems: [],
    ...overrides,
  };
}

function memberKey(overrides: Partial<MemberKeyRecord>): MemberKeyRecord {
  return {
    memberId: 'm-owner',
    userId: 'owner',
    linkId: null,
    publicKey: OWNER_KEY,
    privilege: 'owner',
    visibleFromEpoch: 1,
    ...overrides,
  };
}

/** A rotation body whose wrap set covers exactly `memberKeys`. */
function rotationBody(expectedEpoch: number, memberKeys: Uint8Array[]): RotationBody {
  return {
    expectedEpoch,
    epochPublicKey: B64,
    confirmationHash: B64,
    chainLink: B64,
    memberWraps: memberKeys.map((key) => ({ memberPublicKey: toBase64(key), wrap: B64 })),
    encryptedTitle: B64,
  };
}

/** The epoch/conversation store fragment that lets `applyRotation` run to completion. */
const rotationStores = {
  conversations: {
    lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
    claimRotation: () => okAsync(true),
  },
  epochs: {
    byNumber: () => okAsync({ id: 'epoch-1' }),
    insert: () => okAsync({ id: 'epoch-2' }),
    insertWraps: () => okAsync(),
    deleteWraps: () => okAsync(),
  },
};

describe('createSharedLink', () => {
  const fullHistory = {
    conversationId: CONV,
    callerUserId: 'u1',
    linkPublicKey: KEY,
    displayName: 'a link' as string | null,
    expiresAt: null as string | null,
    privilege: 'read' as const,
    giveFullHistory: true,
    memberWrap: B64 as string | undefined,
    expectedEpoch: 1 as number | undefined,
    rotation: undefined,
  };

  const rotationParams = {
    conversationId: CONV,
    callerUserId: 'u1',
    linkPublicKey: KEY,
    displayName: 'a link' as string | null,
    expiresAt: null as string | null,
    privilege: 'write' as const,
    giveFullHistory: false,
    memberWrap: undefined,
    expectedEpoch: undefined,
    rotation: rotationBody(1, [OWNER_KEY, LINK_KEY]),
  };

  it('refuses not-found when the conversation does not exist', async () => {
    const stores = fakeStores({ conversations: { lockForUpdate: () => okAsync(null) } });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { lockActiveByUser: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses forbidden when the caller lacks link-management privilege', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('converges on the existing link when its key already exists for this conversation', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byPublicKey: () => okAsync(linkRecord()) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({
      link: expect.objectContaining({ id: LINK }),
      created: false,
    });
  });

  it('refuses conflict when the key already exists for another conversation', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'owner' })) },
      sharedLinks: { byPublicKey: () => okAsync(linkRecord({ conversationId: 'other' })) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
  });

  it('refuses member-limit when the conversation is at capacity', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(100),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'member-limit', limit: 100 });
  });

  it('seats a full-history guest and wraps the current epoch key, without rotating', async () => {
    let wraps: unknown = null;
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        insertLinkMember: () => okAsync({ id: 'member-9' }),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(linkRecord()) },
      epochs: {
        byNumber: () => okAsync({ id: 'epoch-1' }),
        insertWraps: (rows) => {
          wraps = rows;
          return okAsync();
        },
      },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({
      link: expect.objectContaining({ id: LINK }),
      created: true,
      memberId: 'member-9',
      newEpochNumber: null,
    });
    expect(wraps).toEqual([
      {
        epochId: 'epoch-1',
        memberPublicKey: LINK_KEY,
        wrap: expect.any(Uint8Array),
        visibleFromEpoch: 1,
      },
    ]);
  });

  it('refuses stale-epoch when a full-history wrap was built for another epoch', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 3 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, { ...fullHistory, expectedEpoch: 1 });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'stale-epoch', currentEpoch: 3 });
  });

  it('refuses validation when a full-history mint is missing its wrap material', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, {
      ...fullHistory,
      memberWrap: undefined,
      expectedEpoch: undefined,
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'validation' });
  });

  it('treats a missing current epoch row as a defect on the full-history path', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
      epochs: { byNumber: () => okAsync(null) },
    });
    await expect(createSharedLink(stores, fullHistory)).rejects.toThrow(
      /current epoch row missing/
    );
  });

  it('answers conflict when the link insert loses a concurrent cross-conversation race', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(null) },
      epochs: { byNumber: () => okAsync({ id: 'epoch-1' }) },
    });
    const result = await createSharedLink(stores, fullHistory);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
  });

  it('treats a lost link-member insert as a defect under the conversation lock', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        insertLinkMember: () => okAsync(null),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(linkRecord()) },
      epochs: { byNumber: () => okAsync({ id: 'epoch-1' }) },
    });
    await expect(createSharedLink(stores, fullHistory)).rejects.toThrow(/link member insert lost/);
  });

  it('seats a rotation guest and rotates the epoch, seating the link key', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
        claimRotation: rotationStores.conversations.claimRotation,
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
        insertLinkMember: () => okAsync({ id: 'member-r' }),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(linkRecord()) },
      epochs: rotationStores.epochs,
    });
    const result = await createSharedLink(stores, rotationParams);
    expect(result._unsafeUnwrap()).toEqual({
      link: expect.objectContaining({ id: LINK }),
      created: true,
      memberId: 'member-r',
      newEpochNumber: 2,
    });
  });

  it('answers conflict when a rotation-path link insert loses a cross-conversation race', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
      },
      sharedLinks: { byPublicKey: () => okAsync(null), insert: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, rotationParams);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
  });

  it('refuses validation when a rotation mint is missing its rotation payload', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, { ...rotationParams, rotation: undefined });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'validation' });
  });

  it('refuses stale-epoch when the rotation was built for another epoch', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 5 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, rotationParams);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'stale-epoch', currentEpoch: 5 });
  });

  it('refuses wrap-set-mismatch when the rotation wrap set does not cover the members plus link', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        // Two existing members but the rotation only carries owner + link.
        activeVisibilityByKey: () =>
          okAsync(
            new Map([
              [toBase64(OWNER_KEY), 1],
              [toBase64(new Uint8Array([9, 9, 9])), 1],
            ])
          ),
      },
      sharedLinks: { byPublicKey: () => okAsync(null) },
    });
    const result = await createSharedLink(stores, rotationParams);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'wrap-set-mismatch' });
  });

  it('parses an expiry instant and serializes the stored timestamps', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
      },
      members: {
        lockActiveByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        countActive: () => okAsync(1),
        insertLinkMember: () => okAsync({ id: 'member-9' }),
      },
      sharedLinks: {
        byPublicKey: () => okAsync(null),
        insert: () => okAsync(linkRecord({ revokedAt: new Date(5), expiresAt: new Date(10) })),
      },
      epochs: {
        byNumber: () => okAsync({ id: 'epoch-1' }),
        insertWraps: () => okAsync(),
      },
    });
    const result = await createSharedLink(stores, {
      ...fullHistory,
      expiresAt: '2026-07-01T00:00:00.000Z',
    });
    expect(result._unsafeUnwrap()).toEqual({
      link: {
        id: LINK,
        displayName: 'a link',
        privilege: 'read',
        revokedAt: new Date(5).toISOString(),
        expiresAt: new Date(10).toISOString(),
        createdAt: new Date(0).toISOString(),
      },
      created: true,
      memberId: 'member-9',
      newEpochNumber: null,
    });
  });
});

describe('listSharedLinks', () => {
  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await listSharedLinks(stores, {
      conversationId: CONV,
      caller: { kind: 'user', userId: 'u1' },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('lists the conversation links for an active member', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      sharedLinks: {
        listForConversation: () =>
          okAsync([
            { ...linkRecord(), privilege: 'write' as const },
            { ...linkRecord({ id: 'link-2' }), privilege: 'read' as const },
          ]),
      },
    });
    const result = await listSharedLinks(stores, {
      conversationId: CONV,
      caller: { kind: 'user', userId: 'u1' },
    });
    expect(result._unsafeUnwrap()).toMatchObject({ links: [{ id: LINK }, { id: 'link-2' }] });
  });

  it("carries each link's seated privilege into the view", async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: {
        listForConversation: () =>
          okAsync([
            { ...linkRecord(), privilege: 'write' as const },
            { ...linkRecord({ id: 'link-2' }), privilege: 'read' as const },
          ]),
      },
    });
    const result = await listSharedLinks(stores, {
      conversationId: CONV,
      caller: { kind: 'user', userId: 'u1' },
    });
    expect(result._unsafeUnwrap()).toEqual({
      links: [
        expect.objectContaining({ id: LINK, privilege: 'write' }),
        expect.objectContaining({ id: 'link-2', privilege: 'read' }),
      ],
    });
  });
});

describe('revokeSharedLink', () => {
  const params = {
    conversationId: CONV,
    linkId: LINK,
    callerUserId: 'u1',
    rotation: rotationBody(1, [OWNER_KEY]),
  };

  /** Active keys where the owner remains and the revoked link is still present. */
  const keysWithLink = () =>
    okAsync([
      memberKey({}),
      memberKey({
        memberId: 'm-link',
        userId: null,
        linkId: LINK,
        publicKey: LINK_KEY,
        privilege: 'read',
      }),
    ]);

  function revokeStores(
    overrides: Parameters<typeof fakeStores>[0]
  ): ReturnType<typeof fakeStores> {
    return fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 1 })),
        claimRotation: rotationStores.conversations.claimRotation,
      },
      members: {
        activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        activeKeysOrdered: keysWithLink,
        markLeftByLink: () => okAsync({ id: 'm-link' }),
        ...overrides.members,
      },
      sharedLinks: {
        byId: () => okAsync(linkRecord()),
        revoke: () => okAsync(linkRecord({ revokedAt: new Date(1) })),
        ...overrides.sharedLinks,
      },
      epochs: rotationStores.epochs,
      ...Object.fromEntries(
        Object.entries(overrides).filter(([key]) => key !== 'members' && key !== 'sharedLinks')
      ),
    });
  }

  it('refuses not-found when the conversation does not exist', async () => {
    const stores = fakeStores({ conversations: { lockForUpdate: () => okAsync(null) } });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the caller is not an active member', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { activeByUser: () => okAsync(null) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses forbidden when the caller lacks link-management privilege', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('refuses not-found when the link does not exist', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(null) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses not-found when the link belongs to another conversation', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ conversationId: 'other' })) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('is an idempotent no-op when the link is already revoked', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord({ id: CONV })) },
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ revokedAt: new Date(1) })) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ revoked: true, alreadyRevoked: true });
  });

  it('refuses stale-epoch when the departure rotation targets another epoch', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord({ id: CONV, currentEpoch: 4 })),
      },
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(linkRecord()) },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'stale-epoch', currentEpoch: 4 });
  });

  it('refuses wrap-set-mismatch when the departure set does not cover the remaining members', async () => {
    const stores = revokeStores({
      members: {
        activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        // Two remaining members but the rotation only carries the owner.
        activeKeysOrdered: () =>
          okAsync([
            memberKey({}),
            memberKey({ memberId: 'm2', userId: 'u2', publicKey: new Uint8Array([3, 3, 3]) }),
            memberKey({ memberId: 'm-link', userId: null, linkId: LINK, publicKey: LINK_KEY }),
          ]),
      },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'wrap-set-mismatch' });
  });

  it('revokes a live link: marks the guest left, rotates the epoch out, and evicts the link', async () => {
    const stores = revokeStores({});
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({
      revoked: true,
      memberId: 'm-link',
      newEpochNumber: 2,
      evicteePrincipalIds: [LINK],
    });
  });

  it('revokes a member-less link (no active guest) with a null member id', async () => {
    const stores = revokeStores({
      members: {
        activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        activeKeysOrdered: () => okAsync([memberKey({})]),
        markLeftByLink: () => okAsync(null),
      },
    });
    const result = await revokeSharedLink(stores, params);
    expect(result._unsafeUnwrap()).toEqual({
      revoked: true,
      memberId: null,
      newEpochNumber: 2,
      evicteePrincipalIds: [LINK],
    });
  });

  it('treats a missed revoke under the conversation lock as a defect', async () => {
    const stores = revokeStores({
      sharedLinks: { byId: () => okAsync(linkRecord()), revoke: () => okAsync(null) },
    });
    await expect(revokeSharedLink(stores, params)).rejects.toThrow(/revoke matched no row/);
  });
});

describe('createSharedMessage', () => {
  const params = {
    conversationId: CONV,
    callerUserId: 'u1',
    messageId: 'msg-1',
    wrappedContentKey: toBase64(new Uint8Array([9])),
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

  it('creates a standalone shared message stamped with the creating user', async () => {
    let captured: { messageId: string; createdBy: string } | null = null;
    const stores = fakeStores({
      members: { lockActiveByUser: () => okAsync(memberRecord({ privilege: 'read' })) },
      messages: { inConversation: () => okAsync(true) },
      sharedMessages: {
        insert: (p) => {
          captured = { messageId: p.messageId, createdBy: p.createdBy };
          return okAsync({ id: 'share-1', createdAt: new Date(0) });
        },
      },
    });
    const result = await createSharedMessage(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ shareId: 'share-1' });
    expect(captured).toEqual({ messageId: 'msg-1', createdBy: 'u1' });
  });
});

describe('readSharedMessage', () => {
  it('refuses not-found when the share does not exist', async () => {
    const stores = fakeStores({ sharedMessages: { byId: () => okAsync(null) } });
    const result = await readSharedMessage(stores, { shareId: 'share-x' });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('returns exactly the one shared message and its content items', async () => {
    let requestedShareId: string | null = null;
    const stores = fakeStores({
      sharedMessages: {
        byId: (shareId) => {
          requestedShareId = shareId;
          return okAsync(sharedMessage());
        },
      },
    });
    const result = await readSharedMessage(stores, { shareId: 'shared-msg-1' });
    expect(result._unsafeUnwrap()).toEqual({
      shareId: 'shared-msg-1',
      messageId: 'msg-1',
      wrappedContentKey: toBase64(new Uint8Array([1, 2])),
      createdAt: new Date(0).toISOString(),
      contentItems: [],
    });
    expect(requestedShareId).toBe('shared-msg-1');
  });
});

describe('changeLinkPrivilege', () => {
  const params = {
    conversationId: CONV,
    callerUserId: 'admin-u',
    linkId: LINK,
    privilege: 'write' as const,
  };

  it('refuses a caller who is not a member (not-found)', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses a non-admin caller (forbidden)', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('answers not-found for a missing link', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(null) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('answers not-found for a revoked link', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ revokedAt: new Date(1) })) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('answers not-found for a link of another conversation', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: { byId: () => okAsync(linkRecord({ conversationId: 'other' })) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('updates the guest member row and returns its id', async () => {
    let updated: { conversationId: string; linkId: string; privilege: string } | null = null;
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })),
        updatePrivilegeByLink: (p) => {
          updated = p;
          return okAsync({ id: 'guest-member-1' });
        },
      },
      sharedLinks: { byId: () => okAsync(linkRecord()) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ changed: true, memberId: 'guest-member-1' });
    expect(updated).toEqual({ conversationId: CONV, linkId: LINK, privilege: 'write' });
  });

  it('reports a null member id when the link seats no active guest', async () => {
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(memberRecord({ privilege: 'owner' })),
        updatePrivilegeByLink: () => okAsync(null),
      },
      sharedLinks: { byId: () => okAsync(linkRecord()) },
    });
    const result = await changeLinkPrivilege(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ changed: true, memberId: null });
  });
});

describe('changeLinkName', () => {
  const params = {
    conversationId: CONV,
    callerUserId: 'admin-u',
    linkId: LINK,
    displayName: 'renamed',
  };

  it('refuses a caller who is not a member (not-found)', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await changeLinkName(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses a non-admin caller (forbidden)', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'write' })) },
    });
    const result = await changeLinkName(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('renames a live link', async () => {
    let written: { conversationId: string; linkId: string; displayName: string } | null = null;
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      sharedLinks: {
        updateDisplayName: (p) => {
          written = p;
          return okAsync(true);
        },
      },
    });
    const result = await changeLinkName(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ success: true });
    expect(written).toEqual({ conversationId: CONV, linkId: LINK, displayName: 'renamed' });
  });

  it('answers not-found when the link is missing or revoked', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'owner' })) },
      sharedLinks: { updateDisplayName: () => okAsync(false) },
    });
    const result = await changeLinkName(stores, params);
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});
