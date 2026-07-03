import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { getKeyChain } from './keychain.js';
import { conversationRecord, fakeStores, memberRecord, userRow } from './test-fixtures.js';

const CALLER_KEY = new Uint8Array(32).fill(7);

describe('getKeyChain', () => {
  it('answers not-found for a missing conversation', async () => {
    const stores = fakeStores({ conversations: { get: () => okAsync(null) } });
    const result = await getKeyChain(stores, { conversationId: 'c1', callerUserId: 'owner' });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });

  it('treats a missing users row for an authenticated member as a defect', async () => {
    const stores = fakeStores({
      conversations: { get: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: () => okAsync(null) },
    });
    await expect(
      getKeyChain(stores, { conversationId: 'c1', callerUserId: 'owner' })
    ).rejects.toThrow(/no users row/);
  });

  it('answers not-found for a member holding no wraps', async () => {
    const stores = fakeStores({
      conversations: { get: () => okAsync(conversationRecord()) },
      members: { activeByUser: () => okAsync(memberRecord()) },
      users: { byId: (id) => userRow(id, CALLER_KEY) },
      epochs: { wrapsForKey: () => okAsync([]), chainLinks: () => okAsync([]) },
    });
    const result = await getKeyChain(stores, { conversationId: 'c1', callerUserId: 'owner' });
    expect(result._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});
