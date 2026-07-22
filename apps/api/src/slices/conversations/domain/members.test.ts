import { describe, expect, it } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import {
  acceptInviteTransition,
  addMember,
  changeMemberPrivilege,
  declineInviteTransition,
  leaveConversation,
  removeMember,
} from './members.js';
import { conversationRecord, fakeStores, memberRecord, userRow } from './test-fixtures.js';
import type { RotationBody } from './schemas.js';

/**
 * Defect and refusal arms unreachable through the routes: the schema
 * refinements block malformed bodies at the boundary, and the conversation
 * lock makes the mid-transaction races these guards answer impossible to
 * stage against real Postgres.
 */

const OWNER_KEY = new Uint8Array(32).fill(1);
const TARGET_KEY = new Uint8Array(32).fill(2);
const B64 = toBase64(new Uint8Array([1, 2, 3]));

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

const owner = memberRecord();
const targetMember = memberRecord({ id: 'm-target', userId: 'target', privilege: 'write' });

describe('addMember unreachable-by-route arms', () => {
  function addStores(
    overrides: Parameters<typeof fakeStores>[0] = {}
  ): ReturnType<typeof fakeStores> {
    return fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: {
        activeByUser: (_c, userId) => okAsync(userId === 'owner' ? owner : null),
        countActive: () => okAsync(0),
        ...overrides.members,
      },
      users: { byId: (id) => userRow(id, TARGET_KEY) },
      ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'members')),
    });
  }

  it('refuses a full-history add missing its wrap material', async () => {
    const result = await addMember(addStores(), {
      conversationId: 'c1',
      callerUserId: 'owner',
      body: { userId: 'target', privilege: 'write', giveFullHistory: true },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'validation' });
  });

  it('refuses a full-history wrap built for a stale epoch', async () => {
    const result = await addMember(addStores(), {
      conversationId: 'c1',
      callerUserId: 'owner',
      body: {
        userId: 'target',
        privilege: 'write',
        giveFullHistory: true,
        wrap: B64,
        expectedEpoch: 2,
      },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'stale-epoch', currentEpoch: 1 });
  });

  it('treats a missing current epoch row as a defect on the full-history path', async () => {
    const stores = addStores({ epochs: { byNumber: () => okAsync(null) } });
    await expect(
      addMember(stores, {
        conversationId: 'c1',
        callerUserId: 'owner',
        body: {
          userId: 'target',
          privilege: 'write',
          giveFullHistory: true,
          wrap: B64,
          expectedEpoch: 1,
        },
      })
    ).rejects.toThrow(/current epoch row missing/);
  });

  it('converges a full-history insert lost to the active-unique index', async () => {
    const stores = addStores({
      epochs: { byNumber: () => okAsync({ id: 'e1' }) },
      members: {
        activeByUser: (_c, userId) => okAsync(userId === 'owner' ? owner : null),
        countActive: () => okAsync(0),
        insert: () => okAsync(null),
      },
    });
    const result = await addMember(stores, {
      conversationId: 'c1',
      callerUserId: 'owner',
      body: {
        userId: 'target',
        privilege: 'write',
        giveFullHistory: true,
        wrap: B64,
        expectedEpoch: 1,
      },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'already-member' });
  });

  it('refuses a rotation add missing its rotation payload', async () => {
    const result = await addMember(addStores(), {
      conversationId: 'c1',
      callerUserId: 'owner',
      body: { userId: 'target', privilege: 'write', giveFullHistory: false },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'validation' });
  });

  it('converges a rotation-path insert lost to the active-unique index', async () => {
    const stores = addStores({
      members: {
        activeByUser: (_c, userId) => okAsync(userId === 'owner' ? owner : null),
        countActive: () => okAsync(0),
        activeVisibilityByKey: () => okAsync(new Map([[toBase64(OWNER_KEY), 1]])),
        insert: () => okAsync(null),
      },
    });
    const result = await addMember(stores, {
      conversationId: 'c1',
      callerUserId: 'owner',
      body: {
        userId: 'target',
        privilege: 'write',
        giveFullHistory: false,
        rotation: rotationBody(1, [OWNER_KEY, TARGET_KEY]),
      },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'already-member' });
  });
});

describe('removeMember link-guest gating', () => {
  it('refuses to remove a link-guest member through the user path', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: {
        activeByUser: () => okAsync(owner),
        activeById: () => okAsync(memberRecord({ id: 'm-link', userId: null, privilege: 'read' })),
      },
    });
    const result = await removeMember(stores, {
      conversationId: 'c1',
      memberId: 'm-link',
      callerUserId: 'owner',
      rotation: rotationBody(1, [OWNER_KEY]),
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'validation' });
  });
});

describe('removeMember defect arms', () => {
  it('treats a users row missing for an active member as a defect', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: {
        activeByUser: () => okAsync(owner),
        activeById: () => okAsync(targetMember),
      },
      users: { byId: () => okAsync(null) },
    });
    await expect(
      removeMember(stores, {
        conversationId: 'c1',
        memberId: 'm-target',
        callerUserId: 'owner',
        rotation: rotationBody(1, [OWNER_KEY]),
      })
    ).rejects.toThrow(/users row missing/);
  });

  it('treats a member vanishing under the conversation lock as a defect', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: {
        activeByUser: () => okAsync(owner),
        activeById: () => okAsync(targetMember),
        activeVisibilityByKey: () =>
          okAsync(
            new Map([
              [toBase64(OWNER_KEY), 1],
              [toBase64(TARGET_KEY), 1],
            ])
          ),
        markLeft: () => okAsync(null),
      },
      users: { byId: (id) => userRow(id, TARGET_KEY) },
    });
    await expect(
      removeMember(stores, {
        conversationId: 'c1',
        memberId: 'm-target',
        callerUserId: 'owner',
        rotation: rotationBody(1, [OWNER_KEY]),
      })
    ).rejects.toThrow(/vanished under the conversation lock/);
  });
});

describe('leaveConversation defect arms', () => {
  it('treats an owner-privilege member without the conversation row as a defect', async () => {
    const stores = fakeStores({
      conversations: {
        lockForUpdate: () => okAsync(conversationRecord()),
        deleteOwned: () => okAsync(false),
      },
      members: {
        activeByUser: () => okAsync(owner),
        activePrincipalIds: () => okAsync(['owner']),
      },
    });
    await expect(
      leaveConversation(stores, { conversationId: 'c1', callerUserId: 'owner' })
    ).rejects.toThrow(/does not own the conversation row/);
  });

  it('treats the leaver vanishing under the conversation lock as a defect', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: {
        activeByUser: () => okAsync(targetMember),
        activeVisibilityByKey: () =>
          okAsync(
            new Map([
              [toBase64(OWNER_KEY), 1],
              [toBase64(TARGET_KEY), 1],
            ])
          ),
        markLeft: () => okAsync(null),
      },
      users: { byId: (id) => userRow(id, TARGET_KEY) },
    });
    await expect(
      leaveConversation(stores, {
        conversationId: 'c1',
        callerUserId: 'target',
        rotation: rotationBody(1, [OWNER_KEY]),
      })
    ).rejects.toThrow(/vanished under the conversation lock/);
  });
});

const adminCaller = memberRecord({ id: 'm-admin', userId: 'admin1', privilege: 'admin' });
const writeTarget = memberRecord({ id: 'm-target', userId: 'target', privilege: 'write' });

describe('removeMember authorization ladder', () => {
  it('refuses removing a member the caller is not strictly senior to as privilege-insufficient', async () => {
    const peerAdmin = memberRecord({ id: 'm-peer', userId: 'admin2', privilege: 'admin' });
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: {
        activeByUser: () => okAsync(adminCaller),
        activeById: () => okAsync(peerAdmin),
      },
    });
    const result = await removeMember(stores, {
      conversationId: 'c1',
      memberId: 'm-peer',
      callerUserId: 'admin1',
      rotation: rotationBody(1, [OWNER_KEY]),
    });
    // Legacy answered the distinct PRIVILEGE_INSUFFICIENT here, matching the
    // sibling privilege-change path — not the generic FORBIDDEN.
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'privilege-insufficient' });
  });

  it('refuses a non-admin caller as privilege-insufficient', async () => {
    const stores = fakeStores({
      conversations: { lockForUpdate: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(writeTarget) },
    });
    const result = await removeMember(stores, {
      conversationId: 'c1',
      memberId: 'm-other',
      callerUserId: 'target',
      rotation: rotationBody(1, [OWNER_KEY]),
    });
    // Legacy mounted requirePrivilege('admin'), which answered
    // PRIVILEGE_INSUFFICIENT for a below-admin caller — not the generic FORBIDDEN.
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'privilege-insufficient' });
  });
});

describe('changeMemberPrivilege authorization ladder', () => {
  it('lets an admin change a lower member to a privilege below its own and writes it', async () => {
    let written: { memberId: string; privilege: string } | null = null;
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(adminCaller),
        activeById: () => okAsync(writeTarget),
        updatePrivilege: (params) => {
          written = { memberId: params.memberId, privilege: params.privilege };
          return okAsync(true);
        },
      },
    });
    const result = await changeMemberPrivilege(stores, {
      conversationId: 'c1',
      callerUserId: 'admin1',
      memberId: 'm-target',
      privilege: 'read',
    });
    expect(result._unsafeUnwrap()).toEqual({
      updated: true,
      memberId: 'm-target',
      privilege: 'read',
    });
    expect(written).toEqual({ memberId: 'm-target', privilege: 'read' });
  });

  it('refuses a non-member caller as not-found', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await changeMemberPrivilege(stores, {
      conversationId: 'c1',
      callerUserId: 'ghost',
      memberId: 'm-target',
      privilege: 'admin',
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses a non-admin caller as privilege-insufficient', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(writeTarget) },
    });
    const result = await changeMemberPrivilege(stores, {
      conversationId: 'c1',
      callerUserId: 'target',
      memberId: 'm-other',
      privilege: 'read',
    });
    // Legacy mounted requirePrivilege('admin'), which answered
    // PRIVILEGE_INSUFFICIENT for a below-admin caller — not the generic FORBIDDEN.
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'privilege-insufficient' });
  });

  it('answers not-found when the target member does not exist', async () => {
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(adminCaller),
        activeById: () => okAsync(null),
      },
    });
    const result = await changeMemberPrivilege(stores, {
      conversationId: 'c1',
      callerUserId: 'admin1',
      memberId: 'm-missing',
      privilege: 'read',
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('refuses changing the caller own privilege', async () => {
    const selfTarget = memberRecord({ id: 'm-admin', userId: 'admin1', privilege: 'admin' });
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(adminCaller),
        activeById: () => okAsync(selfTarget),
      },
    });
    const result = await changeMemberPrivilege(stores, {
      conversationId: 'c1',
      callerUserId: 'admin1',
      memberId: 'm-admin',
      privilege: 'write',
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'cannot-change-own-privilege' });
  });

  it('refuses a grant that is not strictly below the caller (owner unreachable)', async () => {
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(adminCaller),
        activeById: () => okAsync(writeTarget),
      },
    });
    const result = await changeMemberPrivilege(stores, {
      conversationId: 'c1',
      callerUserId: 'admin1',
      memberId: 'm-target',
      privilege: 'owner',
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'privilege-insufficient' });
  });

  it('refuses changing a member not strictly below the caller', async () => {
    const peerAdmin = memberRecord({ id: 'm-peer', userId: 'admin2', privilege: 'admin' });
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(adminCaller),
        activeById: () => okAsync(peerAdmin),
      },
    });
    const result = await changeMemberPrivilege(stores, {
      conversationId: 'c1',
      callerUserId: 'admin1',
      memberId: 'm-peer',
      privilege: 'read',
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'privilege-insufficient' });
  });

  it('answers not-found when the target departs before the conditional write', async () => {
    const stores = fakeStores({
      members: {
        activeByUser: () => okAsync(adminCaller),
        activeById: () => okAsync(writeTarget),
        updatePrivilege: () => okAsync(false),
      },
    });
    const result = await changeMemberPrivilege(stores, {
      conversationId: 'c1',
      callerUserId: 'admin1',
      memberId: 'm-target',
      privilege: 'read',
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});

describe('acceptInviteTransition', () => {
  it('flips a pending membership to accepted', async () => {
    const stores = fakeStores({ members: { setAccepted: () => okAsync(true) } });
    const params = acceptInviteTransition(stores, { conversationId: 'c1', callerUserId: 'u1' });
    const value = await params.transition();
    expect(value._unsafeUnwrap()).toEqual({ accepted: true });
  });

  it('treats an already-accepted member as an idempotent no-op', async () => {
    const stores = fakeStores({
      members: {
        setAccepted: () => okAsync(false),
        activeByUser: () => okAsync(memberRecord({ userId: 'u1' })),
      },
    });
    const params = acceptInviteTransition(stores, { conversationId: 'c1', callerUserId: 'u1' });
    const transitioned = await params.transition();
    const disambiguated = await params.onZeroRows();
    expect(transitioned._unsafeUnwrap()).toBeNull();
    expect(disambiguated._unsafeUnwrap()).toEqual({ accepted: true });
  });

  it('answers not-found when the caller is not an active member', async () => {
    const stores = fakeStores({
      members: { setAccepted: () => okAsync(false), activeByUser: () => okAsync(null) },
    });
    const params = acceptInviteTransition(stores, { conversationId: 'c1', callerUserId: 'ghost' });
    const disambiguated = await params.onZeroRows();
    expect(disambiguated._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});

describe('declineInviteTransition', () => {
  it('marks a pending membership left and yields its id', async () => {
    const stores = fakeStores({ members: { declinePending: () => okAsync({ id: 'm-9' }) } });
    const params = declineInviteTransition(stores, { conversationId: 'c1', callerUserId: 'u1' });
    const transitioned = await params.transition();
    expect(transitioned._unsafeUnwrap()).toEqual({ declined: true, memberId: 'm-9' });
  });

  it('refuses declining an already-accepted membership as validation', async () => {
    const stores = fakeStores({
      members: {
        declinePending: () => okAsync(null),
        activeByUser: () => okAsync(memberRecord({ userId: 'u1' })),
      },
    });
    const params = declineInviteTransition(stores, { conversationId: 'c1', callerUserId: 'u1' });
    const transitioned = await params.transition();
    const disambiguated = await params.onZeroRows();
    expect(transitioned._unsafeUnwrap()).toBeNull();
    expect(disambiguated._unsafeUnwrap()).toEqual({ refusal: 'validation' });
  });

  it('answers not-found when the caller is not an active member', async () => {
    const stores = fakeStores({
      members: { declinePending: () => okAsync(null), activeByUser: () => okAsync(null) },
    });
    const params = declineInviteTransition(stores, { conversationId: 'c1', callerUserId: 'ghost' });
    const disambiguated = await params.onZeroRows();
    expect(disambiguated._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});
