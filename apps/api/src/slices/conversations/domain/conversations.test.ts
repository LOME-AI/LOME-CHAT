import { describe, expect, it } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { createConversation, deleteConversation, getConversation } from './conversations.js';
import { conversationRecord, fakeStores, memberRecord } from './test-fixtures.js';

const B64 = toBase64(new Uint8Array([1, 2, 3]));

describe('createConversation unreachable-by-route arms', () => {
  it('treats an authenticated principal without a users row as a defect', async () => {
    const stores = fakeStores({
      conversations: { insert: () => okAsync(conversationRecord()) },
      users: { byId: () => okAsync(null) },
    });
    await expect(
      createConversation(stores, {
        callerUserId: 'owner',
        id: 'c1',
        epochPublicKey: B64,
        confirmationHash: B64,
        memberWrap: B64,
      })
    ).rejects.toThrow(/no users row/);
  });

  it('answers conflict when a lost insert converges on a vanished conversation', async () => {
    const stores = fakeStores({
      conversations: { insert: () => okAsync(null), get: () => okAsync(null) },
    });
    const result = await createConversation(stores, {
      callerUserId: 'owner',
      id: 'c1',
      epochPublicKey: B64,
      confirmationHash: B64,
      memberWrap: B64,
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
  });
});

describe('getConversation zero-row disambiguation', () => {
  it('answers not-found when the conversation vanished after the membership read', async () => {
    const stores = fakeStores({
      conversations: { get: () => okAsync(null) },
      members: { activeByUser: () => okAsync(memberRecord()) },
    });
    const result = await getConversation(stores, { conversationId: 'c1', callerUserId: 'owner' });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});

describe('deleteConversation zero-row disambiguation', () => {
  it('answers not-found when the conversation vanished after the membership read', async () => {
    const stores = fakeStores({
      conversations: { deleteOwned: () => okAsync(false), get: () => okAsync(null) },
      members: {
        activeByUser: () => okAsync(memberRecord()),
        activePrincipalIds: () => okAsync(['owner']),
      },
    });
    const result = await deleteConversation(stores, {
      conversationId: 'c1',
      callerUserId: 'owner',
    });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});
