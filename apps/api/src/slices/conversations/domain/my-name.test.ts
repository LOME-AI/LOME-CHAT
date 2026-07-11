import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { getMyName, setMyNameTransition } from './my-name.js';
import { fakeStores, memberRecord, userRow } from './test-fixtures.js';

describe('getMyName', () => {
  it("answers a user caller's username and privilege", async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord({ privilege: 'admin' })) },
      users: { byId: (id) => userRow(id, new Uint8Array(32)) },
    });
    const result = await getMyName(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'u1' },
    });
    expect(result._unsafeUnwrap()).toEqual({ displayName: 'user-u1', privilege: 'admin' });
  });

  it('answers not-found for a non-member user', async () => {
    const stores = fakeStores({ members: { activeByUser: () => okAsync(null) } });
    const result = await getMyName(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'u1' },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('throws when an authenticated member has no users row (a defect)', async () => {
    const stores = fakeStores({
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: () => okAsync(null) },
    });
    await expect(
      getMyName(stores, { conversationId: 'c1', caller: { kind: 'user', userId: 'u1' } })
    ).rejects.toThrow(/no users row/);
  });

  it("answers a link guest's link display name and member privilege", async () => {
    const stores = fakeStores({
      members: {
        activeLinkGuest: () =>
          okAsync({
            member: memberRecord({ privilege: 'read' }),
            publicKey: new Uint8Array(32),
            displayName: 'Guest label',
          }),
      },
    });
    const result = await getMyName(stores, {
      conversationId: 'c1',
      caller: { kind: 'linkGuest', linkId: 'l1', conversationId: 'c1' },
    });
    expect(result._unsafeUnwrap()).toEqual({ displayName: 'Guest label', privilege: 'read' });
  });

  it('answers not-found for a link guest with no active member row (revoked/left)', async () => {
    const stores = fakeStores({ members: { activeLinkGuest: () => okAsync(null) } });
    const result = await getMyName(stores, {
      conversationId: 'c1',
      caller: { kind: 'linkGuest', linkId: 'l1', conversationId: 'c1' },
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});

describe('setMyNameTransition', () => {
  const guest = { kind: 'linkGuest' as const, linkId: 'l1', conversationId: 'c1' };

  function activeGuest() {
    return okAsync({
      member: memberRecord({ id: 'gm1', userId: null, privilege: 'read' }),
      publicKey: new Uint8Array(32),
      displayName: 'old',
    });
  }

  it('forbids a full-session user (no link display name to set)', async () => {
    const stores = fakeStores({});
    const t = setMyNameTransition(stores, {
      conversationId: 'c1',
      caller: { kind: 'user', userId: 'u1' },
      displayName: 'x',
    });
    const outcome = await t.transition();
    expect(outcome._unsafeUnwrap()).toEqual({ refusal: 'forbidden' });
  });

  it('renames the live link for an active guest', async () => {
    let written: { conversationId: string; linkId: string; displayName: string } | null = null;
    const stores = fakeStores({
      members: { activeLinkGuest: () => activeGuest() },
      sharedLinks: {
        updateDisplayName: (p) => {
          written = p;
          return okAsync(true);
        },
      },
    });
    const t = setMyNameTransition(stores, {
      conversationId: 'c1',
      caller: guest,
      displayName: 'new',
    });
    const outcome = await t.transition();
    expect(outcome._unsafeUnwrap()).toEqual({ success: true });
    expect(written).toEqual({ conversationId: 'c1', linkId: 'l1', displayName: 'new' });
  });

  it('yields the zero-row no-op for a departed guest', async () => {
    const stores = fakeStores({ members: { activeLinkGuest: () => okAsync(null) } });
    const t = setMyNameTransition(stores, {
      conversationId: 'c1',
      caller: guest,
      displayName: 'x',
    });
    const outcome = await t.transition();
    expect(outcome._unsafeUnwrap()).toBeNull();
    const zeroRows = await t.onZeroRows();
    expect(zeroRows._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('yields the zero-row no-op when the link is gone concurrently', async () => {
    const stores = fakeStores({
      members: { activeLinkGuest: () => activeGuest() },
      sharedLinks: { updateDisplayName: () => okAsync(false) },
    });
    const t = setMyNameTransition(stores, {
      conversationId: 'c1',
      caller: guest,
      displayName: 'x',
    });
    const outcome = await t.transition();
    expect(outcome._unsafeUnwrap()).toBeNull();
  });
});
